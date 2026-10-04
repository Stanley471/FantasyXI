/**
 * Strict Draft Mode Service (Issue 160)
 * Enforces mutual exclusivity of player ownership per league with concurrency locking
 * and automated fallback pick algorithm.
 */

export interface LeaguePlayerOwnership {
  id: string;
  leagueId: string;
  playerId: number;
  squadId: string;
  roundDrafted: number;
  pickNumber: number;
  draftedAt: Date;
}

export interface PlayerCandidate {
  id: number;
  displayName: string;
  position: "GKP" | "DEF" | "MID" | "FWD";
  price: number;
  totalPoints: number;
}

export interface DraftRoomState {
  leagueId: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  squadOrder: string[]; // List of squad IDs in draft order
  currentPickIndex: number; // 0 to (totalPicks - 1)
  currentRound: number;
  currentTurnSquadId: string;
  turnDeadline: Date;
  timePerPickSec: number;
  picks: LeaguePlayerOwnership[];
}

export class PlayerAlreadyDraftedError extends Error {
  public leagueId: string;
  public playerId: number;
  public existingSquadId: string;

  constructor(leagueId: string, playerId: number, existingSquadId: string) {
    super(`Player ${playerId} is already owned by squad ${existingSquadId} in league ${leagueId}`);
    this.name = "PlayerAlreadyDraftedError";
    this.leagueId = leagueId;
    this.playerId = playerId;
    this.existingSquadId = existingSquadId;
  }
}

export class NotYourTurnError extends Error {
  constructor(squadId: string, currentTurnSquadId: string) {
    super(`It is not squad ${squadId}'s turn to draft (active turn: ${currentTurnSquadId})`);
    this.name = "NotYourTurnError";
  }
}

// In-memory mutex map to guarantee strict transactional concurrency per league
const leagueMutexes: Map<string, Promise<unknown>> = new Map();

async function withLeagueLock<T>(leagueId: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = leagueMutexes.get(leagueId) || Promise.resolve();
  let release: () => void;
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  leagueMutexes.set(leagueId, nextLock);

  try {
    await currentLock;
    return await fn();
  } finally {
    release!();
    if (leagueMutexes.get(leagueId) === nextLock) {
      leagueMutexes.delete(leagueId);
    }
  }
}

export class DraftService {
  // Store ownership map: `leagueId:playerId` -> LeaguePlayerOwnership
  private ownershipMap: Map<string, LeaguePlayerOwnership> = new Map();
  private draftRooms: Map<string, DraftRoomState> = new Map();
  private listeners: Map<string, Set<(event: any) => void>> = new Map();

  public createDraftRoom(
    leagueId: string,
    squadOrder: string[],
    timePerPickSec: number = 60
  ): DraftRoomState {
    const state: DraftRoomState = {
      leagueId,
      status: "IN_PROGRESS",
      squadOrder,
      currentPickIndex: 0,
      currentRound: 1,
      currentTurnSquadId: squadOrder[0],
      turnDeadline: new Date(Date.now() + timePerPickSec * 1000),
      timePerPickSec,
      picks: [],
    };
    this.draftRooms.set(leagueId, state);
    return state;
  }

  public getDraftRoom(leagueId: string): DraftRoomState | undefined {
    return this.draftRooms.get(leagueId);
  }

  public subscribe(leagueId: string, listener: (event: any) => void): () => void {
    if (!this.listeners.has(leagueId)) {
      this.listeners.set(leagueId, new Set());
    }
    this.listeners.get(leagueId)!.add(listener);
    return () => {
      this.listeners.get(leagueId)?.delete(listener);
    };
  }

  private broadcast(leagueId: string, event: Record<string, unknown>): void {
    const roomListeners = this.listeners.get(leagueId);
    if (roomListeners) {
      for (const listener of roomListeners) {
        listener(event);
      }
    }
  }

  /**
   * Executes a draft pick with atomic concurrency locking.
   * Throws PlayerAlreadyDraftedError if the player is already owned in this league.
   */
  public async executeDraftPick(
    leagueId: string,
    squadId: string,
    playerId: number
  ): Promise<LeaguePlayerOwnership> {
    return withLeagueLock(leagueId, async () => {
      const room = this.draftRooms.get(leagueId);
      if (room && room.status === "IN_PROGRESS") {
        if (room.currentTurnSquadId !== squadId) {
          throw new NotYourTurnError(squadId, room.currentTurnSquadId);
        }
      }

      // 1. Strict mutual exclusivity check within this league
      const key = `${leagueId}:${playerId}`;
      const existing = this.ownershipMap.get(key);
      if (existing) {
        throw new PlayerAlreadyDraftedError(leagueId, playerId, existing.squadId);
      }

      const pickNumber = room ? room.picks.length + 1 : 1;
      const round = room ? Math.floor((pickNumber - 1) / room.squadOrder.length) + 1 : 1;

      const record: LeaguePlayerOwnership = {
        id: `own_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        leagueId,
        playerId,
        squadId,
        roundDrafted: round,
        pickNumber,
        draftedAt: new Date(),
      };

      this.ownershipMap.set(key, record);

      if (room) {
        room.picks.push(record);
        // Advance snake/round-robin turn
        const nextIndex = room.currentPickIndex + 1;
        const totalSquads = room.squadOrder.length;
        const nextRound = Math.floor(nextIndex / totalSquads) + 1;

        // Snake draft turn calculation: reverse order on even rounds
        let nextSquadId: string;
        const roundIndex = nextIndex % totalSquads;
        if (nextRound % 2 === 1) {
          nextSquadId = room.squadOrder[roundIndex];
        } else {
          nextSquadId = room.squadOrder[totalSquads - 1 - roundIndex];
        }

        room.currentPickIndex = nextIndex;
        room.currentRound = nextRound;
        room.currentTurnSquadId = nextSquadId;
        room.turnDeadline = new Date(Date.now() + room.timePerPickSec * 1000);

        this.broadcast(leagueId, {
          type: "DRAFT_PICK_MADE",
          pick: record,
          nextTurn: {
            squadId: nextSquadId,
            round: nextRound,
            pickIndex: nextIndex,
            deadline: room.turnDeadline,
          },
        });
      }

      return record;
    });
  }

  /**
   * Fallback auto-pick algorithm if manager misses their timer:
   * Selects highest-value available player (by totalPoints or price) not yet drafted in league.
   */
  public async executeAutoPick(
    leagueId: string,
    squadId: string,
    availablePlayers: PlayerCandidate[]
  ): Promise<LeaguePlayerOwnership> {
    const unpicked = availablePlayers
      .filter((p) => !this.ownershipMap.has(`${leagueId}:${p.id}`))
      .sort((a, b) => b.totalPoints - a.totalPoints || b.price - a.price);

    if (unpicked.length === 0) {
      throw new Error(`No available players left to auto-pick for league ${leagueId}`);
    }

    const highestValuePlayer = unpicked[0];
    const pick = await this.executeDraftPick(leagueId, squadId, highestValuePlayer.id);

    this.broadcast(leagueId, {
      type: "AUTO_PICK_EXECUTED",
      squadId,
      player: highestValuePlayer,
      pick,
    });

    return pick;
  }

  public getPlayerOwner(leagueId: string, playerId: number): string | null {
    return this.ownershipMap.get(`${leagueId}:${playerId}`)?.squadId || null;
  }

  public getLeagueOwnerships(leagueId: string): LeaguePlayerOwnership[] {
    const list: LeaguePlayerOwnership[] = [];
    for (const [k, v] of this.ownershipMap.entries()) {
      if (k.startsWith(`${leagueId}:`)) list.push(v);
    }
    return list;
  }

  public clear(): void {
    this.ownershipMap.clear();
    this.draftRooms.clear();
    this.listeners.clear();
  }
}

export const draftService = new DraftService();
