import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fixtureReschedulingEngine } from "../services/fpl/fixtureReschedulingEngine.js";
import { fixtureReschedulingReconciler } from "../services/fpl/fixtureReschedulingReconciler.js";

test("FixtureReschedulingEngine - Parse reschedule announcement", async () => {
  const incoming = [
    {
      fixtureId: 1,
      fplFixtureId: 101,
      fromGameweekFplId: 10,
      toGameweekFplId: 11,
      postponed: false,
    },
  ];

  const analysis = await fixtureReschedulingEngine.parseRescheduleAnnouncement(
    incoming
  );

  assert.equal(analysis.rescheduledFixtures.length, 1);
  assert.equal(analysis.totalFixturesPostponed, 0);
});

test("FixtureReschedulingEngine - Identify double gameweeks", async () => {
  const incoming = [
    {
      fixtureId: 1,
      fplFixtureId: 101,
      fromGameweekFplId: 10,
      toGameweekFplId: 11,
      postponed: false,
    },
    {
      fixtureId: 2,
      fplFixtureId: 102,
      fromGameweekFplId: 10,
      toGameweekFplId: 11,
      postponed: false,
    },
  ];

  const dgwTeams = await fixtureReschedulingEngine.identifyDoubleGameweeks(
    incoming
  );

  assert.ok(Array.isArray(dgwTeams));
});

test("FixtureReschedulingEngine - Apply deadline adjustments", async () => {
  const incoming = [
    {
      fixtureId: 1,
      fplFixtureId: 101,
      fromGameweekFplId: 10,
      toGameweekFplId: 11,
      postponed: false,
      kickoffTime: new Date(),
    },
  ];

  const adjustments =
    await fixtureReschedulingEngine.applyDynamicDeadlineAdjustments(incoming);

  assert.ok(Array.isArray(adjustments));
});

test("FixtureReschedulingReconciler - Reconcile fixture changes", async () => {
  const incoming = [
    {
      fplId: 101,
      homeTeamFplId: 1,
      awayTeamFplId: 2,
      gameweekFplId: 11,
      postponed: false,
    },
  ];

  const report = await fixtureReschedulingReconciler.reconcileFixtureChanges(
    incoming
  );

  assert.ok(report);
  assert.equal(report.rescheduledCount, 0);
  assert.ok(Array.isArray(report.rescheduledFixtures));
  assert.ok(Array.isArray(report.recalculatedGameweekIds));
});

test("FixtureReschedulingReconciler - Aggregate double gameweek stats", () => {
  const stats = [
    {
      playerId: 1,
      fixtureId: 100,
      minutes: 90,
      goals: 1,
      assists: 0,
      cleanSheet: false,
      bonus: 1,
      totalPoints: 5,
    },
    {
      playerId: 1,
      fixtureId: 101,
      minutes: 45,
      goals: 0,
      assists: 1,
      cleanSheet: true,
      bonus: 3,
      totalPoints: 7,
    },
  ];

  const aggregated =
    fixtureReschedulingReconciler.aggregateDoubleGameweekStats(stats);

  const player1 = aggregated.get(1);
  assert.ok(player1);
  assert.equal(player1.minutes, 135);
  assert.equal(player1.totalPoints, 12);
  assert.equal(player1.fixtureCount, 2);
});
