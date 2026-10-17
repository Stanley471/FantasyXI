export type LiveMatchEventType =
  | "GOAL"
  | "ASSIST"
  | "CLEAN_SHEET_LOST"
  | "YELLOW_CARD"
  | "RED_CARD"
  | "PENALTY_SAVED"
  | "PENALTY_MISSED"
  | "OWN_GOAL"
  | "BONUS_PROVISIONAL";

export interface LiveMatchEvent {
  eventId: string;
  fixtureId: number;
  gameweekId: number;
  playerId: number;
  eventType: LiveMatchEventType;
  pointsDelta: number;
  occurredAtMs: number;
}

export interface SquadPlayerOwnership {
  leagueId: string;
  squadId: string;
  userId: string;
  playerId: number;
  isStarter: boolean;
  /** 1 for normal starter, 2 for Captain, 3 for Triple Captain */
  multiplier: number;
}

export interface ProvisionalLeaderboardEntry {
  squadId: string;
  userId: string;
  baselinePoints: number;
  liveGameweekPoints: number;
  totalProvisionalPoints: number;
  rank: number;
  previousRank: number;
  /** Positive means moved UP the table (e.g. from 5th to 2nd => +3) */
  rankDelta: number;
}

export interface LeaderboardDeltaBroadcast {
  leagueId: string;
  gameweekId: number;
  eventId: string;
  updatedEntries: ProvisionalLeaderboardEntry[];
}

export interface ReconciliationSummary {
  leagueId: string;
  gameweekId: number;
  checkedSquads: number;
  driftedSquads: Array<{
    squadId: string;
    provisionalPoints: number;
    officialPoints: number;
    correctionDelta: number;
  }>;
}

interface InternalSquadScoreState {
  squadId: string;
  userId: string;
  baselinePoints: number;
  liveGameweekPoints: number;
  previousRank: number;
  currentRank: number;
}

export class LiveProvisionalLeaderboardService {
  /** Inverted index: playerId -> list of active starter ownerships across leagues */
  private readonly playerOwnershipIndex = new Map<number, SquadPlayerOwnership[]>();
  /** Per-league squad states: leagueId -> Map<squadId, InternalSquadScoreState> */
  private readonly leagueBoards = new Map<string, Map<string, InternalSquadScoreState>>();
  /** Deduplication set of processed live event IDs */
  private readonly processedEvents = new Set<string>();
  private readonly onBroadcast?: (payload: LeaderboardDeltaBroadcast) => void;

  constructor(options?: {
    onBroadcast?: (payload: LeaderboardDeltaBroadcast) => void;
  }) {
    this.onBroadcast = options?.onBroadcast;
  }

  /**
   * Preloads a league's baseline scores and squad lineups into the in-memory ZSET
   * and inverted player ownership index at the start of a gameweek.
   */
  public registerLeagueSquads(
    leagueId: string,
    squads: Array<{
      squadId: string;
      userId: string;
      baselinePoints: number;
      lineup: Array<{
        playerId: number;
        isStarter: boolean;
        multiplier: number;
      }>;
    }>
  ): void {
    const board = new Map<string, InternalSquadScoreState>();

    for (const sq of squads) {
      board.set(sq.squadId, {
        squadId: sq.squadId,
        userId: sq.userId,
        baselinePoints: sq.baselinePoints,
        liveGameweekPoints: 0,
        previousRank: 1,
        currentRank: 1,
      });

      for (const slot of sq.lineup) {
        if (!slot.isStarter || slot.multiplier <= 0) continue;
        let owners = this.playerOwnershipIndex.get(slot.playerId);
        if (!owners) {
          owners = [];
          this.playerOwnershipIndex.set(slot.playerId, owners);
        }
        owners.push({
          leagueId,
          squadId: sq.squadId,
          userId: sq.userId,
          playerId: slot.playerId,
          isStarter: slot.isStarter,
          multiplier: slot.multiplier,
        });
      }
    }

    this.leagueBoards.set(leagueId, board);
    this.recomputeRanks(leagueId, true);
  }

  /**
   * Ingests a real-time match event in sub-millisecond time without DB reads,
   * increments affected squads using their captaincy multiplier, recomputes ranks,
   * and broadcasts compact rank deltas.
   */
  public ingestLiveEvent(event: LiveMatchEvent): LeaderboardDeltaBroadcast[] {
    if (this.processedEvents.has(event.eventId)) {
      return [];
    }
    this.processedEvents.add(event.eventId);

    const ownerships = this.playerOwnershipIndex.get(event.playerId);
    if (!ownerships || ownerships.length === 0) {
      return [];
    }

    const touchedLeagues = new Map<string, Set<string>>();

    for (const own of ownerships) {
      const board = this.leagueBoards.get(own.leagueId);
      if (!board) continue;

      const squadState = board.get(own.squadId);
      if (!squadState) continue;

      const effectiveDelta = event.pointsDelta * own.multiplier;
      squadState.liveGameweekPoints += effectiveDelta;

      let touchedSquads = touchedLeagues.get(own.leagueId);
      if (!touchedSquads) {
        touchedSquads = new Set<string>();
        touchedLeagues.set(own.leagueId, touchedSquads);
      }
      touchedSquads.add(own.squadId);
    }

    const broadcasts: LeaderboardDeltaBroadcast[] = [];

    for (const [leagueId] of touchedLeagues.entries()) {
      const allRanked = this.recomputeRanks(leagueId, false);
      const changedEntries = allRanked.filter(
        (entry) => entry.rankDelta !== 0 || touchedLeagues.get(leagueId)?.has(entry.squadId)
      );

      const payload: LeaderboardDeltaBroadcast = {
        leagueId,
        gameweekId: event.gameweekId,
        eventId: event.eventId,
        updatedEntries: changedEntries,
      };

      broadcasts.push(payload);
      if (this.onBroadcast) {
        this.onBroadcast(payload);
      }
    }

    return broadcasts;
  }

  /**
   * Returns the current sorted provisional leaderboard for a league.
   */
  public getLeagueStandings(
    leagueId: string,
    limit?: number
  ): ProvisionalLeaderboardEntry[] {
    const ranked = this.recomputeRanks(leagueId, false, true);
    return typeof limit === "number" ? ranked.slice(0, limit) : ranked;
  }

  /**
   * Reconciles provisional live scores with official post-gameweek scores,
   * correcting any discrepancy and returning a drift audit summary.
   */
  public reconcileWithOfficialScores(
    leagueId: string,
    gameweekId: number,
    officialGwScores: Map<string, number>
  ): ReconciliationSummary {
    const board = this.leagueBoards.get(leagueId);
    if (!board) {
      return {
        leagueId,
        gameweekId,
        checkedSquads: 0,
        driftedSquads: [],
      };
    }

    const driftedSquads: ReconciliationSummary["driftedSquads"] = [];

    for (const [squadId, state] of board.entries()) {
      const official = officialGwScores.get(squadId);
      if (official === undefined) continue;

      if (state.liveGameweekPoints !== official) {
        driftedSquads.push({
          squadId,
          provisionalPoints: state.liveGameweekPoints,
          officialPoints: official,
          correctionDelta: official - state.liveGameweekPoints,
        });
        state.liveGameweekPoints = official;
      }
    }

    this.recomputeRanks(leagueId, false);

    return {
      leagueId,
      gameweekId,
      checkedSquads: board.size,
      driftedSquads,
    };
  }

  private recomputeRanks(
    leagueId: string,
    initializeBaselineRank: boolean,
    readOnly: boolean = false
  ): ProvisionalLeaderboardEntry[] {
    const board = this.leagueBoards.get(leagueId);
    if (!board) return [];

    const states = Array.from(board.values());
    states.sort((a, b) => {
      const totalA = a.baselinePoints + a.liveGameweekPoints;
      const totalB = b.baselinePoints + b.liveGameweekPoints;
      if (totalB !== totalA) return totalB - totalA;
      if (b.liveGameweekPoints !== a.liveGameweekPoints) {
        return b.liveGameweekPoints - a.liveGameweekPoints;
      }
      return a.squadId.localeCompare(b.squadId);
    });

    const entries: ProvisionalLeaderboardEntry[] = [];

    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      const newRank = i + 1;
      const prevRank = initializeBaselineRank ? newRank : st.currentRank;

      if (!readOnly) {
        st.previousRank = prevRank;
        st.currentRank = newRank;
      }

      const effectivePrev = readOnly ? st.previousRank : prevRank;
      const effectiveCurr = readOnly ? st.currentRank : newRank;

      entries.push({
        squadId: st.squadId,
        userId: st.userId,
        baselinePoints: st.baselinePoints,
        liveGameweekPoints: st.liveGameweekPoints,
        totalProvisionalPoints: st.baselinePoints + st.liveGameweekPoints,
        rank: effectiveCurr,
        previousRank: effectivePrev,
        rankDelta: effectivePrev - effectiveCurr,
      });
    }

    return entries;
  }
}
