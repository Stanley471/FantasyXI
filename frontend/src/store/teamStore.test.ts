import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTeamStore, LocalSquadPlayer } from "./teamStore";
import { Player, Position } from "@/types";

function makePlayer(id: number, position: Position, teamId = 1): Player {
  return {
    id,
    fplId: id,
    firstName: `First${id}`,
    lastName: `Last${id}`,
    displayName: `Player${id}`,
    position,
    teamId,
    price: 50,
    totalPoints: 0,
    minutesPlayed: 0,
    goalsScored: 0,
    assists: 0,
    cleanSheets: 0,
    photoUrl: null,
  } as Player;
}

function squadPlayer(overrides: Partial<LocalSquadPlayer> & { playerId: number; player: Player }): LocalSquadPlayer {
  return {
    isStarter: true,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: overrides.playerId,
    ...overrides,
  };
}

describe("teamStore.handleSwap", () => {
  beforeEach(() => {
    useTeamStore.setState({ players: [], selectedPlayerId: null });
    vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  it("blocks a starter/bench swap that would drop defenders below the 3 minimum", () => {
    // 3 starting defenders (boundary-legal) + 1 spare bench midfielder.
    const players: LocalSquadPlayer[] = [
      squadPlayer({ playerId: 1, player: makePlayer(1, Position.DEF, 1), isStarter: true }),
      squadPlayer({ playerId: 2, player: makePlayer(2, Position.DEF, 2), isStarter: true }),
      squadPlayer({ playerId: 3, player: makePlayer(3, Position.DEF, 3), isStarter: true }),
      squadPlayer({ playerId: 4, player: makePlayer(4, Position.MID, 4), isStarter: false }),
    ];
    useTeamStore.setState({ players });

    useTeamStore.getState().handleSwap(1, 4);

    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Invalid Formation")
    );
    // The swap must be rejected — state stays exactly as it was.
    const after = useTeamStore.getState().players;
    expect(after.find((p) => p.playerId === 1)!.isStarter).toBe(true);
    expect(after.find((p) => p.playerId === 4)!.isStarter).toBe(false);
  });

  it("allows a starter/bench swap that keeps the formation within FPL limits", () => {
    // 4 DEF / 2 MID / 1 FWD starters + 1 spare bench midfielder: swapping the
    // spare mid in for a defender yields 3-3-1 — still legal.
    const players: LocalSquadPlayer[] = [
      squadPlayer({ playerId: 1, player: makePlayer(1, Position.DEF, 1), isStarter: true }),
      squadPlayer({ playerId: 2, player: makePlayer(2, Position.DEF, 2), isStarter: true }),
      squadPlayer({ playerId: 3, player: makePlayer(3, Position.DEF, 3), isStarter: true }),
      squadPlayer({ playerId: 4, player: makePlayer(4, Position.DEF, 4), isStarter: true }),
      squadPlayer({ playerId: 5, player: makePlayer(5, Position.MID, 5), isStarter: true }),
      squadPlayer({ playerId: 6, player: makePlayer(6, Position.MID, 6), isStarter: true }),
      squadPlayer({ playerId: 7, player: makePlayer(7, Position.FWD, 7), isStarter: true }),
      squadPlayer({ playerId: 8, player: makePlayer(8, Position.MID, 8), isStarter: false }),
    ];
    useTeamStore.setState({ players });

    useTeamStore.getState().handleSwap(1, 8);

    expect(window.alert).not.toHaveBeenCalled();
    const after = useTeamStore.getState().players;
    expect(after.find((p) => p.playerId === 1)!.isStarter).toBe(false);
    expect(after.find((p) => p.playerId === 8)!.isStarter).toBe(true);
  });

  it("blocks swapping a goalkeeper with an outfield player", () => {
    const players: LocalSquadPlayer[] = [
      squadPlayer({ playerId: 1, player: makePlayer(1, Position.GKP, 1), isStarter: true }),
      squadPlayer({ playerId: 2, player: makePlayer(2, Position.DEF, 2), isStarter: false }),
    ];
    useTeamStore.setState({ players });

    useTeamStore.getState().handleSwap(1, 2);

    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Goalkeepers can only be swapped")
    );
    const after = useTeamStore.getState().players;
    expect(after.find((p) => p.playerId === 1)!.isStarter).toBe(true);
  });

  it("moves captaincy along with a demoted starter", () => {
    // A fully legal 3-2-1 outfield lineup around the GK<->GK swap under test.
    const players: LocalSquadPlayer[] = [
      squadPlayer({ playerId: 1, player: makePlayer(1, Position.GKP, 1), isStarter: true, isCaptain: true }),
      squadPlayer({ playerId: 2, player: makePlayer(2, Position.GKP, 2), isStarter: false }),
      squadPlayer({ playerId: 3, player: makePlayer(3, Position.DEF, 3), isStarter: true }),
      squadPlayer({ playerId: 4, player: makePlayer(4, Position.DEF, 4), isStarter: true }),
      squadPlayer({ playerId: 5, player: makePlayer(5, Position.DEF, 5), isStarter: true }),
      squadPlayer({ playerId: 6, player: makePlayer(6, Position.MID, 6), isStarter: true }),
      squadPlayer({ playerId: 7, player: makePlayer(7, Position.MID, 7), isStarter: true }),
      squadPlayer({ playerId: 8, player: makePlayer(8, Position.FWD, 8), isStarter: true }),
    ];
    useTeamStore.setState({ players });

    useTeamStore.getState().handleSwap(1, 2);

    expect(window.alert).not.toHaveBeenCalled();
    const after = useTeamStore.getState().players;
    expect(after.find((p) => p.playerId === 1)!.isCaptain).toBe(false);
    expect(after.find((p) => p.playerId === 2)!.isCaptain).toBe(true);
  });
});
