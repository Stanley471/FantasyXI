import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  LEAGUE_SCORING_PRESETS,
} from "../models/leagueScoringConfig.js";
import { ScoringService } from "../services/scoring/scoringService.js";
import { Position } from "../types/index.js";

const positions = [
  Position.GKP,
  Position.DEF,
  Position.DEF,
  Position.DEF,
  Position.DEF,
  Position.MID,
  Position.MID,
  Position.MID,
  Position.MID,
  Position.FWD,
  Position.FWD,
  Position.GKP,
  Position.MID,
  Position.DEF,
  Position.FWD,
];
const players = positions.map((position, index) => ({
  playerId: index + 1,
  position,
  isStarter: index < 11,
  isCaptain: index === 0,
  isViceCaptain: index === 5,
  positionOrder: index + 1,
}));
const stats = new Map(
  players.map((player) => [
    player.playerId,
    {
      minutes: 90,
      totalPoints: 0,
      goals: 1,
      assists: 1,
      saves: 3,
      bonus: 1,
    },
  ])
);
const iterations = 10_000;

const first = ScoringService.calculateLineupScore(players, stats, {
  scoringConfig: LEAGUE_SCORING_PRESETS.ALL_ATTACK,
});
assert.equal(first.totalPoints, 200);

const startedAt = performance.now();
for (let index = 0; index < iterations; index++) {
  const score = ScoringService.calculateLineupScore(players, stats, {
    scoringConfig: LEAGUE_SCORING_PRESETS.ALL_ATTACK,
  });
  assert.equal(score.totalPoints, 200);
}
const elapsedMs = performance.now() - startedAt;
console.log(
  `Custom scoring benchmark: ${iterations} lineups in ${elapsedMs.toFixed(1)} ms ` +
    `(${Math.round((iterations * 1000) / elapsedMs)} lineups/sec)`
);
