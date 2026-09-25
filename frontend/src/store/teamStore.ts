import { create } from "zustand";
import { Player, Position } from "@/types";
import { validateSubstitution } from "@/lib/formation";

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

interface TeamState {
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
  handleSwap: (playerAId: number, playerBId: number) => boolean;
  handleSetCaptain: (playerId: number) => void;
  handleSetViceCaptain: (playerId: number) => void;
  handlePlayerClick: (clickedPlayer: Player | null, position?: Position) => void;
}

export const useTeamStore = create<TeamState>((set, get) => ({
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
      set({
        substitutionFeedback: {
          type: "error",
          message: validation.reason || "Invalid substitution move.",
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

    set({
      players: clone,
      substitutionFeedback: {
        type: "success",
        message: `Successfully substituted ${a.player.displayName || a.player.lastName} with ${b.player.displayName || b.player.lastName}.`,
      },
    });
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
  },

  handleSetViceCaptain: (playerId) => {
    set((state) => ({
      players: state.players.map((p) => ({
        ...p,
        isViceCaptain: p.playerId === playerId,
        isCaptain: p.playerId === playerId ? false : p.isCaptain,
      }))
    }));
  },
}));
