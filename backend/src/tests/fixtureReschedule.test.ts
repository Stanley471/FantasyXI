import test from "node:test";
import assert from "node:assert/strict";
import { Position, ChipType } from "../types/index.js";
import {
  FixtureRescheduleService,
  ExternalFixtureRecord,
  PlayerFixturePerformance,
} from "../services/fpl/fixtureRescheduleService.js";

test("FixtureRescheduleService: classifies postponed, rescheduled (BGW -> DGW), and abandoned fixtures", () => {
  const fixtures: ExternalFixtureRecord[] = [
    {
      fixtureId: 101,
      homeTeamId: 1,
      awayTeamId: 2,
      originalGameweekId: 18,
      currentGameweekId: null, // Postponed indefinitely
      finished: false,
      minutesPlayed: 0,
    },
    {
      fixtureId: 102,
      homeTeamId: 3,
      awayTeamId: 4,
      originalGameweekId: 18,
      currentGameweekId: 25, // Rescheduled into GW 25
      finished: false,
      minutesPlayed: 0,
    },
    {
      fixtureId: 201,
      homeTeamId: 3,
      awayTeamId: 5,
      originalGameweekId: 25,
      currentGameweekId: 25, // Team 3 now has 2 fixtures in GW 25 (DGW!)
      finished: true,
      minutesPlayed: 90,
    },
  ];

  const transitions = FixtureRescheduleService.classifyFixtureTransitions(fixtures);
  assert.equal(transitions[0].status, "POSTPONED");
  assert.equal(transitions[0].createsBlankInGameweek, 18);

  assert.equal(transitions[1].status, "RESCHEDULED");
  assert.equal(transitions[1].createsBlankInGameweek, 18);
  assert.equal(transitions[1].createsDoubleInGameweek, 25);

  assert.equal(transitions[2].status, "FINISHED");
  assert.equal(transitions[2].createsDoubleInGameweek, 25);
});

test("FixtureRescheduleService: handles DGW score accumulation, captaincy multiplier, and BGW auto-subs", () => {
  // GW 25: Team 1 has a DGW (fixtures 301 & 302), Team 2 has a BGW (fixture postponed), Team 3 has 1 fixture (303)
  const fixtures: ExternalFixtureRecord[] = [
    {
      fixtureId: 301,
      homeTeamId: 1,
      awayTeamId: 4,
      originalGameweekId: 25,
      currentGameweekId: 25,
      finished: true,
      minutesPlayed: 90,
    },
    {
      fixtureId: 302,
      homeTeamId: 1,
      awayTeamId: 5,
      originalGameweekId: 18,
      currentGameweekId: 25,
      finished: true,
      minutesPlayed: 90,
    },
    {
      fixtureId: 303,
      homeTeamId: 3,
      awayTeamId: 6,
      originalGameweekId: 25,
      currentGameweekId: 25,
      finished: true,
      minutesPlayed: 90,
    },
  ];

  // Build valid 11 starters + 4 bench
  const squad = [
    { playerId: 1, teamId: 1, position: Position.GKP, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 1 },
    { playerId: 2, teamId: 1, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 },
    { playerId: 3, teamId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
    { playerId: 4, teamId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 },
    { playerId: 5, teamId: 2, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 }, // BGW starter!
    { playerId: 6, teamId: 3, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 6 },
    { playerId: 7, teamId: 3, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
    { playerId: 8, teamId: 3, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
    { playerId: 9, teamId: 1, position: Position.FWD, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 9 }, // DGW Captain!
    { playerId: 10, teamId: 3, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: true, positionOrder: 10 },
    { playerId: 11, teamId: 3, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },
    { playerId: 12, teamId: 3, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
    { playerId: 13, teamId: 3, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 }, // Bench sub!
  ];

  const performances: PlayerFixturePerformance[] = [
    // DGW Captain (player 9) scores 8 pts in Match 1 and 11 pts in Match 2 = 19 raw pts (38 as Captain)
    { playerId: 9, teamId: 1, fixtureId: 301, gameweekId: 25, minutes: 90, goalsPoints: 4, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 4 },
    { playerId: 9, teamId: 1, fixtureId: 302, gameweekId: 25, minutes: 85, goalsPoints: 8, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 3 },
    // Bench player 13 scores 7 pts and subs in for BGW player 5
    { playerId: 13, teamId: 3, fixtureId: 303, gameweekId: 25, minutes: 90, goalsPoints: 5, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    // Other starters play 90 mins with 2 appearance points each
    { playerId: 1, teamId: 1, fixtureId: 301, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    { playerId: 2, teamId: 1, fixtureId: 301, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    { playerId: 3, teamId: 3, fixtureId: 303, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    { playerId: 4, teamId: 3, fixtureId: 303, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    { playerId: 6, teamId: 3, fixtureId: 303, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    { playerId: 7, teamId: 3, fixtureId: 303, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    { playerId: 8, teamId: 3, fixtureId: 303, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    { playerId: 10, teamId: 3, fixtureId: 303, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
    { playerId: 11, teamId: 3, fixtureId: 303, gameweekId: 25, minutes: 90, goalsPoints: 0, assistsPoints: 0, cleanSheetPoints: 0, otherPoints: 2 },
  ];

  const score = FixtureRescheduleService.calculateRescheduledGameweekLineupScore(
    25,
    squad,
    fixtures,
    performances
  );

  // DGW captain (player 9) gets 19 * 2 = 38 points (captain bonus = 19)
  assert.equal(score.captainPoints, 19);
  const bgwStarter = score.details.find((d) => d.playerId === 5)!;
  const benchReplacement = score.details.find((d) => d.playerId === 13)!;
  assert.equal(bgwStarter.subbedOut, true);
  assert.equal(benchReplacement.subbedIn, true);
  // Total = 9 starters * 2 (18) + bench sub (7) + DGW Captain (38) = 63
  assert.equal(score.totalPoints, 63);
});

test("FixtureRescheduleService: enforces abandoned match rules at minute 55 vs minute 75", () => {
  const perf: PlayerFixturePerformance = {
    playerId: 44,
    teamId: 1,
    fixtureId: 500,
    gameweekId: 30,
    minutes: 75,
    goalsPoints: 6,
    assistsPoints: 0,
    cleanSheetPoints: 4,
    otherPoints: 2,
  };

  // Abandoned at minute 55: clean sheet stripped (< 60m), goal & appearance preserved
  const abandoned55 = FixtureRescheduleService.evaluateFixturePerformance(perf, {
    fixtureId: 500,
    homeTeamId: 1,
    awayTeamId: 2,
    originalGameweekId: 30,
    currentGameweekId: 30,
    finished: false,
    minutesPlayed: 55,
    abandoned: true,
    voidStatsOnAbandonment: false,
  });
  assert.equal(abandoned55.minutes, 55);
  assert.equal(abandoned55.totalPoints, 8); // 6 (goal) + 2 (other), no 4 CS points

  // Abandoned at minute 75: clean sheet preserved (>= 60m)
  const abandoned75 = FixtureRescheduleService.evaluateFixturePerformance(perf, {
    fixtureId: 500,
    homeTeamId: 1,
    awayTeamId: 2,
    originalGameweekId: 30,
    currentGameweekId: 30,
    finished: false,
    minutesPlayed: 75,
    abandoned: true,
    voidStatsOnAbandonment: false,
  });
  assert.equal(abandoned75.minutes, 75);
  assert.equal(abandoned75.totalPoints, 12); // 6 + 4 + 2
});
