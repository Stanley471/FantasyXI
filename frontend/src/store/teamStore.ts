import { create } from "zustand";
import { Player, Position, Squad, SQUAD_RULES } from "@/types";
import { emitToast } from "@/context/ToastContext";
import { validateCompleteSquad, validateSubstitution } from "@/lib/formation";
import { enqueueSquadMutation, QueuedSquadMutation, SquadMutationPayload } from "@/lib/offlineQueue";
import { saveSquadSnapshot } from "@/lib/offlineStore";
import {
  appendJournalEntry,
  ensureJournalBase,
  type JournalPlayer,
  type NewJournalEntry,
} from "@/lib/transferJournal";

export interface LocalSquadPlayer {
  id?: number | string;
  playerId: number;
  player: Player;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number;
}

export interface SubstitutionFeedback {
  type: "success" | "error";
  message: string;
}

/** Body of a squad create/replace request; positionOrder follows the local list order. */
export function buildSquadPayload(name: string, players: LocalSquadPlayer[]): SquadMutationPayload {
  return {
    name: name.trim() || "My Fantasy XI",
    players: players.map((p, idx) => ({
      playerId: p.playerId,
      isStarter: p.isStarter,
      isCaptain: p.isCaptain,
      isViceCaptain: p.isViceCaptain,
      positionOrder: idx + 1,
    })),
  };
}

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

interface TeamState {
  /** Signed-in manager whose squad this is; needed to queue offline changes. */
  ownerId: string | null;
  setOwnerId: (id: string | null) => void;
  squadId: string | null;
  setSquadId: (id: string | null) => void;
  squadName: string;
  setSquadName: (name: string) => void;
  players: LocalSquadPlayer[];
  setPlayers: (players: LocalSquadPlayer[] | ((prev: LocalSquadPlayer[]) => LocalSquadPlayer[])) => void;
  
  selectedPlayerId: number | null;
  setSelectedPlayerId: (id: number | null) => void;

  activeDragPlayer: LocalSquadPlayer | null;
  setActiveDragPlayer: (player: LocalSquadPlayer | null) => void;

  substitutionFeedback: SubstitutionFeedback | null;
  setSubstitutionFeedback: (feedback: SubstitutionFeedback | null) => void;

  /**
   * Last substitution rejected by the formation rules (#462): the dragged
   * card snaps back with this reason shown, instead of silently staying put.
   * Set by handleSwap on failure, cleared by a successful swap or a new drag.
   */
  rejectedSwap: { sourcePlayerId: number; targetPlayerId: number; reason: string } | null;
  setRejectedSwap: (rejected: { sourcePlayerId: number; targetPlayerId: number; reason: string } | null) => void;

  /** Player card holding keyboard focus, for the Space/arrows/Enter flow (#462). */
  keyboardFocusedPlayerId: number | null;
  setKeyboardFocusedPlayerId: (id: number | null) => void;
  
  activeModalState: {
    isOpen: boolean;
    requiredPosition: Position | null;
    replacingPlayer: Player | null;
  };
  setActiveModalState: (state: { isOpen: boolean; requiredPosition: Position | null; replacingPlayer: Player | null }) => void;
  
  // Actions
  /** Replaces local state with a squad loaded from the server or the offline snapshot. */
  hydrateFromSquad: (squad: Squad) => void;
  /**
   * Persists the current lineup to the offline queue and snapshot so it
   * survives reloads and syncs on reconnection (issue #334). Returns null when
   * the lineup is incomplete or invalid, since the server would reject it.
   */
  persistLineupOffline: () => Promise<QueuedSquadMutation | null>;
  handleSwap: (playerAId: number, playerBId: number) => boolean;
  handleSetCaptain: (playerId: number) => void;
  handleSetViceCaptain: (playerId: number) => void;
  handlePlayerClick: (clickedPlayer: Player | null, position?: Position) => void;
  /**
   * Records a transfer (replace) in the offline transfer journal
   * (issue #457) so it can be replayed, reviewed and merged on reconnect.
   * Only records while offline; online saves go straight to the API.
   */
  recordTransfer: (incoming: Player, outgoing: LocalSquadPlayer) => void;
}

export const useTeamStore = create<TeamState>((set, get) => ({
  ownerId: null,
  setOwnerId: (id) => set({ ownerId: id }),

  squadId: null,
  setSquadId: (id) => set({ squadId: id }),
  
  squadName: "My Fantasy XI",
  setSquadName: (name) => set({ squadName: name }),
  
  players: [],
  setPlayers: (updater) => set((state) => ({
    players: typeof updater === 'function' ? updater(state.players) : updater
  })),
  
  selectedPlayerId: null,
  setSelectedPlayerId: (id) => set({ selectedPlayerId: id }),

  activeDragPlayer: null,
  setActiveDragPlayer: (player) =>
    set({ activeDragPlayer: player, ...(player ? { rejectedSwap: null } : {}) }),

  substitutionFeedback: null,
  setSubstitutionFeedback: (feedback) => set({ substitutionFeedback: feedback }),

  rejectedSwap: null,
  setRejectedSwap: (rejected) => set({ rejectedSwap: rejected }),

  keyboardFocusedPlayerId: null,
  setKeyboardFocusedPlayerId: (id) => set({ keyboardFocusedPlayerId: id }),
  
  activeModalState: {
    isOpen: false,
    requiredPosition: null,
    replacingPlayer: null,
  },
  setActiveModalState: (modalState) => set({ activeModalState: modalState }),

  hydrateFromSquad: (squad) => {
    set({ squadId: squad.id, squadName: squad.name });
    if (squad.players && squad.players.length > 0) {
      set({
        players: squad.players
          .filter((sp) => sp.player)
          .map((sp) => ({
            id: sp.id,
            playerId: sp.playerId,
            player: sp.player!,
            isStarter: sp.isStarter,
            isCaptain: sp.isCaptain,
            isViceCaptain: sp.isViceCaptain,
            positionOrder: sp.positionOrder,
          })),
      });
    }
  },

  persistLineupOffline: async () => {
    const { ownerId, squadId, squadName, players } = get();
    if (!ownerId || players.length !== SQUAD_RULES.TOTAL_PLAYERS || !validateCompleteSquad(players).valid) {
      return null;
    }

    const payload = buildSquadPayload(squadName, players);
    const mutation = await enqueueSquadMutation({
      squadId,
      userId: ownerId,
      action: squadId ? "update" : "create",
      payload,
    });

    // The snapshot is what a reload shows until the server accepts the change
    saveSquadSnapshot(ownerId, [
      {
        id: squadId ?? "",
        userId: ownerId,
        name: payload.name,
        players: players.map((p, idx) => ({
          id: typeof p.id === "number" ? p.id : idx + 1,
          squadId: squadId ?? "",
          playerId: p.playerId,
          isStarter: p.isStarter,
          isCaptain: p.isCaptain,
          isViceCaptain: p.isViceCaptain,
          positionOrder: idx + 1,
          player: p.player,
        })),
      } as Squad,
    ]);
    return mutation;
  },

  handlePlayerClick: (clickedPlayer, position) => {
    const state = get();
    if (!clickedPlayer) {
      state.setActiveModalState({
        isOpen: true,
        requiredPosition: position || null,
        replacingPlayer: null,
      });
      return;
    }

    if (state.selectedPlayerId && state.selectedPlayerId !== clickedPlayer.id) {
      state.handleSwap(state.selectedPlayerId, clickedPlayer.id);
      state.setSelectedPlayerId(null);
      return;
    }

    state.setSelectedPlayerId(state.selectedPlayerId === clickedPlayer.id ? null : clickedPlayer.id);
  },

  handleSwap: (playerAId, playerBId) => {
    const state = get();
    const prev = state.players;
    const idxA = prev.findIndex((p) => p.playerId === playerAId);
    const idxB = prev.findIndex((p) => p.playerId === playerBId);
    if (idxA === -1 || idxB === -1) return false;

    const a = prev[idxA];
    const b = prev[idxB];

    // Validate substitution
    const validation = validateSubstitution(a, b, prev);
    if (!validation.valid) {
      const message = validation.reason || "Invalid substitution move.";
      emitToast.warning(message);
      set({
        substitutionFeedback: {
          type: "error",
          message,
        },
        // The dragged card snaps back with this reason (#462).
        rejectedSwap: {
          sourcePlayerId: playerAId,
          targetPlayerId: playerBId,
          reason: message,
        },
      });
      return false;
    }

    const clone = [...prev];
    const newA = { ...a };
    const newB = { ...b };

    const tempStarter = newA.isStarter;
    const tempOrder = newA.positionOrder;

    newA.isStarter = newB.isStarter;
    newA.positionOrder = newB.positionOrder;

    newB.isStarter = tempStarter;
    newB.positionOrder = tempOrder;

    // Preserve captain / vice-captain validity
    if (!newA.isStarter && newA.isCaptain) {
      newA.isCaptain = false;
      newB.isCaptain = true;
    }
    if (!newA.isStarter && newA.isViceCaptain) {
      newA.isViceCaptain = false;
      newB.isViceCaptain = true;
    }
    if (!newB.isStarter && newB.isCaptain) {
      newB.isCaptain = false;
      newA.isCaptain = true;
    }
    if (!newB.isStarter && newB.isViceCaptain) {
      newB.isViceCaptain = false;
      newA.isViceCaptain = true;
    }

    clone[idxA] = newA;
    clone[idxB] = newB;

    const successMessage = `Successfully substituted ${a.player.displayName || a.player.lastName} with ${b.player.displayName || b.player.lastName}.`;
    set({
      players: clone,
      rejectedSwap: null,
      substitutionFeedback: {
        type: "success",
        message: successMessage,
      },
    });
    persistIfOffline();
    recordJournalEdit(prev, { kind: "formation", playerId: playerAId, otherPlayerId: playerBId });
    return true;
  },

  handleSetCaptain: (playerId) => {
    const prev = get().players;
    set((state) => ({
      players: state.players.map((p) => ({
        ...p,
        isCaptain: p.playerId === playerId,
        isViceCaptain: p.playerId === playerId ? false : p.isViceCaptain,
      }))
    }));
    persistIfOffline();
    recordJournalEdit(prev, { kind: "captain", playerId });
  },

  handleSetViceCaptain: (playerId) => {
    const prev = get().players;
    set((state) => ({
      players: state.players.map((p) => ({
        ...p,
        isViceCaptain: p.playerId === playerId,
        isCaptain: p.playerId === playerId ? false : p.isCaptain,
      }))
    }));
    persistIfOffline();
    recordJournalEdit(prev, { kind: "vice-captain", playerId });
  },

  recordTransfer: (incoming, outgoing) => {
    recordJournalEdit(get().players, {
      kind: "transfer",
      playerId: incoming.id,
      outgoingPlayerId: outgoing.playerId,
      playerSnapshot: incoming,
      isStarter: outgoing.isStarter,
      positionOrder: outgoing.positionOrder,
    });
  },
}));

/** Lineup edits made offline are queued immediately (optimistic UI, persisted). */
function persistIfOffline(): void {
  if (!isOffline()) return;
  useTeamStore
    .getState()
    .persistLineupOffline()
    .catch(() => emitToast.error("Couldn't save your lineup change on this device."));
}

function toJournalPlayers(players: LocalSquadPlayer[]): JournalPlayer[] {
  return players.map(({ playerId, player, isStarter, isCaptain, isViceCaptain, positionOrder }) => ({
    playerId,
    player,
    isStarter,
    isCaptain,
    isViceCaptain,
    positionOrder,
  }));
}

/**
 * Records one granular draft action in the transfer journal (issue #457).
 * The base snapshot is captured from the pre-edit squad the first time
 * only, so the 3-way merge always has the last synced server state.
 * Fire-and-forget: a journal failure must never block the lineup edit.
 */
function recordJournalEdit(
  beforePlayers: LocalSquadPlayer[],
  entry: Omit<NewJournalEntry, "squadId" | "userId">
): void {
  if (!isOffline()) return;
  const { ownerId, squadId } = useTeamStore.getState();
  if (!ownerId) return;
  const captureBase = squadId
    ? ensureJournalBase(squadId, toJournalPlayers(beforePlayers))
    : Promise.resolve();
  captureBase
    .then(() => appendJournalEntry({ ...entry, squadId, userId: ownerId }))
    .catch(() => emitToast.error("Couldn't save your transfer draft on this device."));
}
