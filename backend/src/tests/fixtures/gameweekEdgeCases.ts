import { ChipType, Position } from "../../types/index.js";
import type { LineupScoreOptions } from "../../services/scoring/scoringService.js";

/**
 * Mock data for historical FPL gameweek edge cases.
 *
 * Every scenario uses the same 4-4-2 squad so expected totals can be verified by hand:
 *
 *   Starters  1 GKP | 2-5 DEF | 6-9 MID (6 = vice-captain) | 10-11 FWD (10 = captain)
 *   Bench     12 GKP | 13 DEF | 14 MID | 15 FWD   (bench priority = positionOrder)
 *
 * Unless a scenario overrides it, every starter plays 90 minutes for 2 points and
 * every bench player plays 90 minutes for 1 point. A player listed in `absent` has
 * no PlayerGameweekStats row at all, which is how blank gameweeks and postponed
 * fixtures reach the scoring engine (FPL's live feed omits players without a fixture).
 *
 * Double gameweek stats are pre-aggregated: FPL's /event/{id}/live endpoint sums a
 * player's `stats` across both fixtures, so a DGW player simply has a larger row.
 */

export interface LineupPlayer {
  playerId: number;
  position: Position;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number;
}

export interface PlayerStatLine {
  minutes: number;
  totalPoints: number;
}

export const CAPTAIN_ID = 10;
export const VICE_CAPTAIN_ID = 6;

const POSITIONS: Record<number, Position> = {
  1: Position.GKP,
  2: Position.DEF,
  3: Position.DEF,
  4: Position.DEF,
  5: Position.DEF,
  6: Position.MID,
  7: Position.MID,
  8: Position.MID,
  9: Position.MID,
  10: Position.FWD,
  11: Position.FWD,
  12: Position.GKP,
  13: Position.DEF,
  14: Position.MID,
  15: Position.FWD,
};

export function buildLineup(): LineupPlayer[] {
  return Object.entries(POSITIONS).map(([id, position]) => {
    const playerId = Number(id);
    return {
      playerId,
      position,
      isStarter: playerId <= 11,
      isCaptain: playerId === CAPTAIN_ID,
      isViceCaptain: playerId === VICE_CAPTAIN_ID,
      positionOrder: playerId,
    };
  });
}

/**
 * Builds the stats map for a scenario: defaults for everyone, then overrides,
 * then removes absent players (no fixture = no stats row).
 */
export function buildStats(
  overrides: Record<number, PlayerStatLine> = {},
  absent: number[] = []
): Map<number, PlayerStatLine> {
  const stats = new Map<number, PlayerStatLine>();
  for (const id of Object.keys(POSITIONS).map(Number)) {
    stats.set(id, { minutes: 90, totalPoints: id <= 11 ? 2 : 1 });
  }
  for (const [id, line] of Object.entries(overrides)) {
    stats.set(Number(id), line);
  }
  for (const id of absent) {
    stats.delete(id);
  }
  return stats;
}

export interface ScoringScenario {
  name: string;
  /** What happened in the real world that this scenario reproduces */
  context: string;
  overrides?: Record<number, PlayerStatLine>;
  absent?: number[];
  options?: LineupScoreOptions;
  expected: {
    startingPoints: number;
    benchPoints: number;
    captainPoints: number;
    transferCost: number;
    totalPoints: number;
    subbedIn: number[];
    subbedOut: number[];
  };
}

export const DOUBLE_GAMEWEEK_SCENARIOS: ScoringScenario[] = [
  {
    name: "captain hauls across both fixtures",
    context: "DGW captain scores 7 + 12 = 19 points over 180 minutes; captaincy doubles the aggregate",
    overrides: { [CAPTAIN_ID]: { minutes: 180, totalPoints: 19 } },
    expected: {
      startingPoints: 38 + 10 * 2,
      benchPoints: 4,
      captainPoints: 19,
      transferCost: 0,
      totalPoints: 58,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "starter benched in the first fixture but plays the second",
    context: "0 minutes in fixture one and a 20 minute cameo in fixture two aggregate to 20 minutes, so no auto-sub",
    overrides: { 7: { minutes: 20, totalPoints: 1 } },
    expected: {
      startingPoints: 4 + 1 + 9 * 2,
      benchPoints: 4,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 23,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "Triple Captain played in a double gameweek",
    context: "The classic DGW Triple Captain: 19 aggregated points tripled to 57",
    overrides: { [CAPTAIN_ID]: { minutes: 180, totalPoints: 19 } },
    options: { chip: ChipType.TRIPLE_CAPTAIN },
    expected: {
      startingPoints: 57 + 10 * 2,
      benchPoints: 4,
      captainPoints: 38,
      transferCost: 0,
      totalPoints: 77,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "Bench Boost played in a double gameweek",
    context: "Every bench player doubles up, so the aggregated bench total counts in full",
    overrides: {
      12: { minutes: 180, totalPoints: 6 },
      13: { minutes: 180, totalPoints: 8 },
      14: { minutes: 150, totalPoints: 5 },
      15: { minutes: 170, totalPoints: 9 },
    },
    options: { chip: ChipType.BENCH_BOOST },
    expected: {
      startingPoints: 4 + 10 * 2,
      benchPoints: 28,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 52,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "Wildcard waives a large hit taken ahead of a double gameweek",
    context: "Managers stacking DGW players often take -8 hits; a Wildcard waives them",
    overrides: { [CAPTAIN_ID]: { minutes: 180, totalPoints: 19 } },
    options: { chip: ChipType.WILDCARD, transferCost: 8 },
    expected: {
      startingPoints: 58,
      benchPoints: 4,
      captainPoints: 19,
      transferCost: 0,
      totalPoints: 58,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "transfer hit applies in a double gameweek without a chip",
    context: "A -8 hit is deducted from the aggregated DGW score",
    overrides: { [CAPTAIN_ID]: { minutes: 180, totalPoints: 19 } },
    options: { transferCost: 8 },
    expected: {
      startingPoints: 58,
      benchPoints: 4,
      captainPoints: 19,
      transferCost: 8,
      totalPoints: 50,
      subbedIn: [],
      subbedOut: [],
    },
  },
];

export const BLANK_GAMEWEEK_SCENARIOS: ScoringScenario[] = [
  {
    name: "two starters' club blanks (no fixture)",
    context:
      "DEF 3 and FWD 11 have no fixture. DEF 13 replaces DEF 3; MID 14 replaces FWD 11 because one FWD still starts",
    absent: [3, 11],
    overrides: {
      13: { minutes: 90, totalPoints: 3 },
      14: { minutes: 90, totalPoints: 2 },
      15: { minutes: 90, totalPoints: 4 },
    },
    expected: {
      startingPoints: 4 + 8 * 2 + 3 + 2,
      benchPoints: 1 + 4,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 25,
      subbedIn: [13, 14],
      subbedOut: [3, 11],
    },
  },
  {
    name: "captain blanks and the vice-captain takes the armband",
    context: "The captain's club blanks, so the vice-captain's 7 points are doubled and the first bench player comes on",
    absent: [CAPTAIN_ID],
    overrides: { [VICE_CAPTAIN_ID]: { minutes: 90, totalPoints: 7 }, 15: { minutes: 90, totalPoints: 3 } },
    expected: {
      startingPoints: 14 + 9 * 2 + 1,
      benchPoints: 1 + 1 + 3,
      captainPoints: 7,
      transferCost: 0,
      totalPoints: 33,
      subbedIn: [13],
      subbedOut: [CAPTAIN_ID],
    },
  },
  {
    name: "captain and vice-captain both blank",
    context: "Nobody receives the multiplier, including the bench players who come on for them",
    absent: [CAPTAIN_ID, VICE_CAPTAIN_ID],
    overrides: { 14: { minutes: 90, totalPoints: 5 }, 15: { minutes: 90, totalPoints: 3 } },
    expected: {
      startingPoints: 9 * 2 + 1 + 5,
      benchPoints: 1 + 3,
      captainPoints: 0,
      transferCost: 0,
      totalPoints: 24,
      subbedIn: [13, 14],
      subbedOut: [VICE_CAPTAIN_ID, CAPTAIN_ID],
    },
  },
  {
    name: "starting goalkeeper blanks",
    context: "Only the bench goalkeeper may replace a goalkeeper, even though outfield bench players are ahead in priority",
    absent: [1],
    overrides: { 12: { minutes: 90, totalPoints: 6 } },
    expected: {
      startingPoints: 6 + 4 + 9 * 2,
      benchPoints: 3,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 28,
      subbedIn: [12],
      subbedOut: [1],
    },
  },
  {
    name: "both goalkeepers blank",
    context: "An outfield bench player can never go in goal, so the starting goalkeeper scores 0",
    absent: [1, 12],
    expected: {
      startingPoints: 4 + 9 * 2,
      benchPoints: 3,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 22,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "the entire squad blanks",
    context: "A squad built entirely from blanking clubs scores 0 without errors or phantom captain points",
    absent: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    options: { transferCost: 4 },
    expected: {
      startingPoints: 0,
      benchPoints: 0,
      captainPoints: 0,
      transferCost: 4,
      totalPoints: -4,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "Bench Boost played into a blank gameweek",
    context: "Blank bench players contribute 0 and no auto-subs happen under Bench Boost",
    absent: [3, 13, 15],
    overrides: { 12: { minutes: 90, totalPoints: 2 }, 14: { minutes: 90, totalPoints: 6 } },
    options: { chip: ChipType.BENCH_BOOST },
    expected: {
      startingPoints: 4 + 9 * 2,
      benchPoints: 8,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 30,
      subbedIn: [],
      subbedOut: [],
    },
  },
];

export const POSTPONEMENT_SCENARIOS: ScoringScenario[] = [
  {
    name: "fixture postponed after the deadline",
    context:
      "DEF 4, DEF 5 and bench DEF 13 play for the postponed club. MID 14 replaces DEF 4, but DEF 5 cannot be " +
      "replaced because the only fit bench outfielder left is a FWD and 3 defenders must start",
    absent: [4, 5, 13],
    overrides: { 14: { minutes: 90, totalPoints: 3 }, 15: { minutes: 90, totalPoints: 2 } },
    expected: {
      startingPoints: 4 + 8 * 2 + 3,
      benchPoints: 1 + 2,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 23,
      subbedIn: [14],
      subbedOut: [4],
    },
  },
  {
    name: "captain's fixture postponed with a Triple Captain active",
    context: "The Triple Captain multiplier moves to the vice-captain rather than being lost",
    absent: [CAPTAIN_ID],
    overrides: { [VICE_CAPTAIN_ID]: { minutes: 90, totalPoints: 5 } },
    options: { chip: ChipType.TRIPLE_CAPTAIN },
    expected: {
      startingPoints: 15 + 9 * 2 + 1,
      benchPoints: 3,
      captainPoints: 10,
      transferCost: 0,
      totalPoints: 34,
      subbedIn: [13],
      subbedOut: [CAPTAIN_ID],
    },
  },
];

export const UNUSUAL_SCORE_SCENARIOS: ScoringScenario[] = [
  {
    name: "captain sent off for negative points",
    context: "A 30 minute red card (-1) is doubled to -2; the player featured so is not auto-subbed",
    overrides: { [CAPTAIN_ID]: { minutes: 30, totalPoints: -1 } },
    options: { transferCost: 4 },
    expected: {
      startingPoints: -2 + 10 * 2,
      benchPoints: 4,
      captainPoints: -1,
      transferCost: 4,
      totalPoints: 14,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "starter plays but scores 0 points",
    context: "A 5 minute cameo with a yellow card (1 - 1 = 0) still counts as playing, so no auto-sub",
    overrides: { 9: { minutes: 5, totalPoints: 0 } },
    expected: {
      startingPoints: 4 + 9 * 2,
      benchPoints: 4,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 22,
      subbedIn: [],
      subbedOut: [],
    },
  },
  {
    name: "unused substitute with 0 minutes is on the bench and not brought on",
    context: "Bench players with a stats row but 0 minutes (unused subs) are skipped by auto-subs",
    absent: [7],
    overrides: { 13: { minutes: 0, totalPoints: 0 }, 14: { minutes: 0, totalPoints: 0 } },
    expected: {
      startingPoints: 4 + 9 * 2 + 1,
      benchPoints: 1,
      captainPoints: 2,
      transferCost: 0,
      totalPoints: 23,
      subbedIn: [15],
      subbedOut: [7],
    },
  },
];

// ============================================================
// Raw FPL API payloads
// ============================================================

/** /event/{id}/live element for a DGW player: stats are summed across both fixtures. */
export const RAW_DGW_LIVE_ELEMENT = {
  id: 355,
  stats: {
    minutes: 180,
    goals_scored: 3,
    assists: 1,
    clean_sheets: 2,
    yellow_cards: 1,
    red_cards: 0,
    saves: 0,
    bonus: 5,
    total_points: 24,
  },
};

/** /fixtures entry after FPL postpones a match: detached from any gameweek, no kickoff. */
export const RAW_POSTPONED_FIXTURE = {
  id: 290,
  event: null,
  team_h: 7,
  team_a: 14,
  kickoff_time: null,
  started: false,
  finished: false,
  team_h_score: null,
  team_a_score: null,
  minutes: 0,
};

/** The same fixture once FPL reschedules it into gameweek 34, creating a DGW. */
export const RAW_RESCHEDULED_FIXTURE = {
  ...RAW_POSTPONED_FIXTURE,
  event: 34,
  kickoff_time: "2026-04-22T18:45:00Z",
};
