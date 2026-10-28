import { create } from "zustand";
import { Player, Position, Squad, SQUAD_RULES } from "@/types";
import { emitToast } from "@/context/ToastContext";
import { validateCompleteSquad, validateSubstitution } from "@/lib/formation";
import { enqueueSquadMutation, QueuedSquadMutation, SquadMutationPayload } from "@/lib/offlineQueue";
import { saveSquadSnapshot } from "@/lib/offlineStore";

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
  setActiveDragPlayer: (player) => set({ activeDragPlayer: player }),

  substitutionFeedback: null,
  setSubstitutionFeedback: (feedback) => set({ substitutionFeedback: feedback }),
  
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
      substitutionFeedback: {
        type: "success",
        message: successMessage,
      },
    });
    persistIfOffline();
    return true;
  },

  handleSetCaptain: (playerId) => {
    set((state) => ({
      players: state.players.map((p) => ({
        ...p,
        isCaptain: p.playerId === playerId,
        isViceCaptain: p.playerId === playerId ? false : p.isViceCaptain,
      }))
    }));
    persistIfOffline();
  },

  handleSetViceCaptain: (playerId) => {
    set((state) => ({
      players: state.players.map((p) => ({
        ...p,
        isViceCaptain: p.playerId === playerId,
        isCaptain: p.playerId === playerId ? false : p.isCaptain,
      }))
    }));
    persistIfOffline();
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
