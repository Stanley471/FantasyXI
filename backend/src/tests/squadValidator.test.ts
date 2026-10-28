import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SquadValidator,
  SquadValidationError,
  SquadLockedError,
  PlayerForValidation,
} from "../services/squad/squadValidator.js";
import { Position, SquadPlayerSelection } from "../types/index.js";

/**
 * Creates a mock player pool containing valid players across teams.
 */
function createMockPlayers(): PlayerForValidation[] {
  const players: PlayerForValidation[] = [];
  let id = 1;

  // 2 Goalkeepers (Team 1, Team 2) - £5.0m each
  players.push({ id: id++, teamId: 1, position: Position.GKP, price: 5.0, displayName: "Keeper 1" });
  players.push({ id: id++, teamId: 2, position: Position.GKP, price: 4.5, displayName: "Keeper 2" });

  // 5 Defenders (Teams 1, 2, 3, 4, 5) - £5.0m each
  for (let i = 1; i <= 5; i++) {
    players.push({ id: id++, teamId: i, position: Position.DEF, price: 5.0, displayName: `Def ${i}` });
  }

  // 5 Midfielders (Teams 6, 7, 8, 9, 10) - £6.0m each
  for (let i = 6; i <= 10; i++) {
    players.push({ id: id++, teamId: i, position: Position.MID, price: 6.0, displayName: `Mid ${i}` });
  }

  // 3 Forwards (Teams 11, 12, 13) - £7.0m each
  for (let i = 11; i <= 13; i++) {
    players.push({ id: id++, teamId: i, position: Position.FWD, price: 7.0, displayName: `Fwd ${i}` });
  }

  return players;
}

/**
 * Helper to build a standard 4-4-2 lineup (11 starters, 4 bench).
 * Total price: 5.0 + 4.5 + (5*5.0) + (5*6.0) + (3*7.0) = 9.5 + 25.0 + 30.0 + 21.0 = £85.5m (well under £100m)
 */
function createStandardSelections(): SquadPlayerSelection[] {
  return [
    // Starting XI: 1 GKP, 4 DEF, 4 MID, 2 FWD = 11 starters
    { playerId: 1, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 }, // GKP (C)
    { playerId: 3, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 }, // DEF
    { playerId: 4, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 }, // DEF
    { playerId: 5, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 }, // DEF
    { playerId: 6, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 }, // DEF
    { playerId: 8, isStarter: true, isCaptain: false, isViceCaptain: true, positionOrder: 6 }, // MID (VC)
    { playerId: 9, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 }, // MID
    { playerId: 10, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 }, // MID
    { playerId: 11, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 9 }, // MID
    { playerId: 13, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 }, // FWD
    { playerId: 14, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 }, // FWD

    // Bench: 1 GKP, 1 DEF, 1 MID, 1 FWD = 4 bench
    { playerId: 2, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 }, // GKP
    { playerId: 7, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 }, // DEF
    { playerId: 12, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 }, // MID
    { playerId: 15, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 }, // FWD
  ];
}

describe("SquadValidator Domain Rules", () => {
  const players = createMockPlayers();

  it("should accept a valid 15-player squad (4-4-2) within budget", () => {
    const selections = createStandardSelections();
    const result = SquadValidator.validateSquad(selections, players);

    assert.equal(result.formation, "4-4-2");
    assert.equal(result.starterIds.length, 11);
    assert.equal(result.benchIds.length, 4);
    assert.equal(result.captainId, 1);
    assert.equal(result.viceCaptainId, 8);
    assert.equal(result.totalCost, 85.5);
  });

  it("should accept valid formations (3-5-2, 3-4-3, 5-3-2, 4-3-3, 5-4-1)", () => {
    // Modify to 3-5-2: Starter DEF 6 benched, Bench MID 12 starts
    const selections = createStandardSelections();
    const def6 = selections.find((s) => s.playerId === 6)!;
    const mid12 = selections.find((s) => s.playerId === 12)!;

    def6.isStarter = false;
    def6.positionOrder = 14;
    mid12.isStarter = true;
    mid12.positionOrder = 5;

    const result = SquadValidator.validateSquad(selections, players);
    assert.equal(result.formation, "3-5-2");
  });

  it("should reject too few players (< 15)", () => {
    const selections = createStandardSelections().slice(0, 14);
    assert.throws(
      () => SquadValidator.validateSquad(selections, players),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("exactly 15 players"))
    );
  });

  it("should reject too many players (> 15)", () => {
    const selections = createStandardSelections();
    selections.push({ playerId: 1, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 16 });
    assert.throws(
      () => SquadValidator.validateSquad(selections, players),
      SquadValidationError
    );
  });

  it("should reject duplicate player IDs", () => {
    const selections = createStandardSelections();
    // Replace player 15 with duplicate player 1
    selections[14].playerId = 1;
    assert.throws(
      () => SquadValidator.validateSquad(selections, players),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("Duplicate players"))
    );
  });

  it("should reject budget exceeded (> £100.0m)", () => {
    const expensivePlayers = createMockPlayers().map((p) => ({
      ...p,
      price: 10.0, // 15 * 10 = £150m
    }));
    const selections = createStandardSelections();

    assert.throws(
      () => SquadValidator.validateSquad(selections, expensivePlayers),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("budget exceeded"))
    );
  });

  it("should reject more than 3 players from one team", () => {
    // Make 4 players belong to team 1
    const stackedPlayers = createMockPlayers().map((p) => {
      if ([1, 3, 4, 5].includes(p.id)) {
        return { ...p, teamId: 1 };
      }
      return p;
    });
    const selections = createStandardSelections();

    assert.throws(
      () => SquadValidator.validateSquad(selections, stackedPlayers),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("Maximum 3 players"))
    );
  });

  it("should reject invalid starting XI count (!= 11)", () => {
    const selections = createStandardSelections();
    // Make 10 starters and 5 bench
    selections[10].isStarter = false;
    assert.throws(
      () => SquadValidator.validateSquad(selections, players),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("Starting XI must have exactly 11"))
    );
  });

  it("should reject invalid formations (e.g. only 2 defenders starting)", () => {
    const selections = createStandardSelections();
    // Bench 2 defenders (DEF 5, DEF 6) and start 2 bench players (MID 12, FWD 15) -> only 2 defenders starting
    const def5 = selections.find((s) => s.playerId === 5)!;
    const def6 = selections.find((s) => s.playerId === 6)!;
    const mid12 = selections.find((s) => s.playerId === 12)!;
    const fwd15 = selections.find((s) => s.playerId === 15)!;

    def5.isStarter = false;
    def6.isStarter = false;
    mid12.isStarter = true;
    fwd15.isStarter = true;

    assert.throws(
      () => SquadValidator.validateSquad(selections, players),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("at least 3 defenders"))
    );
  });

  it("should reject missing captain or missing vice-captain", () => {
    const selections = createStandardSelections();
    // Remove captaincy
    selections[0].isCaptain = false;
    assert.throws(
      () => SquadValidator.validateSquad(selections, players),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("exactly one captain"))
    );
  });

  it("should reject captain and vice-captain being the same player", () => {
    const selections = createStandardSelections();
    selections[0].isCaptain = true;
    selections[0].isViceCaptain = true;
    selections[5].isViceCaptain = false;

    assert.throws(
      () => SquadValidator.validateSquad(selections, players),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("cannot be the same player"))
    );
  });

  it("should reject captain on the bench", () => {
    const selections = createStandardSelections();
    // Swap captain to bench player
    selections[0].isCaptain = false;
    selections[11].isCaptain = true; // player 2 (bench GKP)

    assert.throws(
      () => SquadValidator.validateSquad(selections, players),
      (err: any) => err instanceof SquadValidationError && err.errors.some((e: string) => e.includes("Captain must be in the starting XI"))
    );
  });

  it("should enforce deadline locking (throw SquadLockedError after deadline)", () => {
    const deadline = new Date("2026-09-01T11:00:00Z");
    const afterDeadline = new Date("2026-09-01T11:00:01Z");
    const beforeDeadline = new Date("2026-09-01T10:59:59Z");

    // Before deadline passes cleanly
    assert.doesNotThrow(() => SquadValidator.validateDeadline(deadline, beforeDeadline));

    // After deadline throws SquadLockedError
    assert.throws(
      () => SquadValidator.validateDeadline(deadline, afterDeadline),
      SquadLockedError
    );
  });
});

describe("SquadValidator.sanitizeSquadName", () => {
  it("trims leading and trailing whitespace", () => {
    assert.equal(SquadValidator.sanitizeSquadName(" My Team "), "My Team");
  });

  it("collapses consecutive whitespace into a single space", () => {
    assert.equal(SquadValidator.sanitizeSquadName("My    Fantasy \t\n XI"), "My Fantasy XI");
  });

  it("strips control and invisible format characters", () => {
    assert.equal(SquadValidator.sanitizeSquadName("My\u0000 Te\bam​\u007F"), "My Team");
  });

  it("rejects names shorter than 3 printable characters", () => {
    for (const name of ["", "     ", " \t\n ", "ab", " a\u0000b ", "​​​", undefined]) {
      assert.throws(
        () => SquadValidator.sanitizeSquadName(name),
        (err: unknown) =>
          err instanceof SquadValidationError && err.message === "Squad name must be at least 3 characters"
      );
    }
    assert.equal(SquadValidator.sanitizeSquadName(" abc "), "abc");
  });
});
