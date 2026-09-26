import { create } from "zustand";
import { Player, Position } from "@/types";

export interface LocalSquadPlayer {
  id?: number | string;
  playerId: number;
  player: Player;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number;
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
  
  activeModalState: {
    isOpen: boolean;
    requiredPosition: Position | null;
    replacingPlayer: Player | null;
  };
  setActiveModalState: (state: { isOpen: boolean; requiredPosition: Position | null; replacingPlayer: Player | null }) => void;
  
  // Actions
  handleSwap: (playerAId: number, playerBId: number) => void;
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
    set((state) => {
      const prev = state.players;
      const idxA = prev.findIndex((p) => p.playerId === playerAId);
      const idxB = prev.findIndex((p) => p.playerId === playerBId);
      if (idxA === -1 || idxB === -1) return { players: prev };

      const clone = [...prev];
      const a = { ...clone[idxA] };
      const b = { ...clone[idxB] };

      // GKP can only swap with GKP
      const aIsGkp = a.player.position === Position.GKP;
      const bIsGkp = b.player.position === Position.GKP;
      if (aIsGkp !== bIsGkp) {
        alert("Goalkeepers can only be swapped with other Goalkeepers.");
        return { players: prev };
      }

      // Capture both original starter flags before mutating either player —
      // comparing against a mutated value here previously made the "did this
      // cross the starter/bench boundary?" check below always false, since
      // b.isStarter is reassigned to a's original value in the very next lines.
      const aWasStarter = a.isStarter;
      const bWasStarter = b.isStarter;
      const tempOrder = a.positionOrder;

      a.isStarter = b.isStarter;
      a.positionOrder = b.positionOrder;

      b.isStarter = aWasStarter;
      b.positionOrder = tempOrder;

      if (!a.isStarter && a.isCaptain) {
        a.isCaptain = false;
        b.isCaptain = true;
      }
      if (!a.isStarter && a.isViceCaptain) {
        a.isViceCaptain = false;
        b.isViceCaptain = true;
      }
      if (!b.isStarter && b.isCaptain) {
        b.isCaptain = false;
        a.isCaptain = true;
      }
      if (!b.isStarter && b.isViceCaptain) {
        b.isViceCaptain = false;
        a.isViceCaptain = true;
      }

      clone[idxA] = a;
      clone[idxB] = b;

      // Validate new formation if we swapped a starter with a bench player
      if (aWasStarter !== bWasStarter) {
        // Need to import validateFormation and count starters dynamically. 
        // We will inline the validation logic for Outfields here since we don't have access to validateFormation import easily inside the store without adding the import.
        const newStarters = clone.filter(p => p.isStarter);
        const def = newStarters.filter(p => p.player.position === Position.DEF).length;
        const mid = newStarters.filter(p => p.player.position === Position.MID).length;
        const fwd = newStarters.filter(p => p.player.position === Position.FWD).length;
        
        if (def < 3 || def > 5 || mid < 2 || mid > 5 || fwd < 1 || fwd > 3) {
          alert(`Invalid Formation: This substitution would result in an invalid formation (${def}-${mid}-${fwd}).`);
          return { players: prev };
        }
      }

      return { players: clone };
    });
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
