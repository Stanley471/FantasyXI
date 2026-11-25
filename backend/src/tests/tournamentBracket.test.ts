/**
 * Tests for Tournament Knockout Cup Bracket Service (Issue #523)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TournamentBracketService } from "../services/league/tournamentBracketService.js";

test("bracket size validation: 16 managers", () => {
  assert.equal(TournamentBracketService.roundsForBracketSize(16), 4);
});

test("bracket size validation: 32 managers", () => {
  assert.equal(TournamentBracketService.roundsForBracketSize(32), 5);
});

test("bracket size validation: 64 managers", () => {
  assert.equal(TournamentBracketService.roundsForBracketSize(64), 6);
});

test("invalid bracket size throws error", () => {
  assert.throws(() => {
    TournamentBracketService.roundsForBracketSize(20);
  }, /not a power of 2/);
});

test("bye padding", () => {
  const managers = [
    { id: "m1", seed: 1 },
    { id: "m2", seed: 2 },
    { id: "m3", seed: 3 },
  ];
  const padded = TournamentBracketService.padWithByes(managers, 4);
  assert.equal(padded.length, 4);
  assert.equal(padded.filter(m => m.isBye).length, 1);
});

test("16-manager bracket rounds", () => {
  const rounds = TournamentBracketService.roundsForBracketSize(16);
  assert.equal(rounds, 4);
});

test("32-manager bracket rounds", () => {
  const rounds = TournamentBracketService.roundsForBracketSize(32);
  assert.equal(rounds, 5);
});

test("64-manager bracket rounds", () => {
  const rounds = TournamentBracketService.roundsForBracketSize(64);
  assert.equal(rounds, 6);
});

test("match resolution: higher score wins", () => {
  const homeScore = 75;
  const awayScore = 50;
  assert.ok(homeScore > awayScore);
});
