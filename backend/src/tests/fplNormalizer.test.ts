import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeElementType,
  normalizePrice,
  normalizeTeam,
  normalizePlayer,
  normalizeGameweek,
  normalizeFixture,
  normalizePlayerStats,
} from "../services/fpl/fplNormalizer.js";
import { Position } from "../types/index.js";

describe("FPL Normalizer", () => {
  it("should map FPL element_type to correct Position enum", () => {
    assert.equal(normalizeElementType(1), Position.GKP);
    assert.equal(normalizeElementType(2), Position.DEF);
    assert.equal(normalizeElementType(3), Position.MID);
    assert.equal(normalizeElementType(4), Position.FWD);

    assert.throws(() => normalizeElementType(5), /Unknown FPL element_type/);
  });

  it("should normalize FPL now_cost tenths to millions with 1 decimal", () => {
    assert.equal(normalizePrice(105), 10.5);
    assert.equal(normalizePrice(45), 4.5);
    assert.equal(normalizePrice(140), 14.0);
    assert.equal(normalizePrice(0), 0.0);
    assert.equal(normalizePrice(NaN), 0.0);
  });

  it("should normalize raw FPL team data", () => {
    const raw = {
      id: 1,
      name: "Arsenal",
      short_name: "ARS",
      strength: 4,
      strength_overall_home: 1250,
      strength_overall_away: 1270,
      strength_attack_home: 1280,
      strength_attack_away: 1290,
      strength_defence_home: 1240,
      strength_defence_away: 1260,
    };

    const team = normalizeTeam(raw);
    assert.equal(team.fplId, 1);
    assert.equal(team.name, "Arsenal");
    assert.equal(team.shortName, "ARS");
    assert.equal(team.strength, 4);
    assert.equal(
      team.logoUrl,
      "https://resources.premierleague.com/premierleague/badges/70/t1.png"
    );
  });

  it("should normalize raw FPL player element data", () => {
    const raw = {
      id: 254,
      first_name: "Erling",
      second_name: "Haaland",
      web_name: "Haaland",
      element_type: 4,
      now_cost: 152,
      total_points: 180,
      minutes: 2100,
      goals_scored: 22,
      assists: 5,
      clean_sheets: 0,
      form: "7.8",
      status: "a",
      news: "",
      chance_of_playing_next_round: 100,
      selected_by_percent: "68.5",
      photo: "223340.jpg",
    };

    const player = normalizePlayer(raw);
    assert.equal(player.fplId, 254);
    assert.equal(player.displayName, "Haaland");
    assert.equal(player.position, Position.FWD);
    assert.equal(player.price, 15.2);
    assert.equal(player.totalPoints, 180);
    assert.equal(player.goalsScored, 22);
    assert.equal(player.form, 7.8);
    assert.equal(player.isAvailable, true);
    assert.equal(
      player.photoUrl,
      "https://resources.premierleague.com/premierleague/photos/players/110x140/p223340.png"
    );
  });

  it("should normalize raw FPL gameweek data", () => {
    const raw = {
      id: 1,
      name: "Gameweek 1",
      deadline_time: "2025-08-15T17:30:00Z",
      is_current: true,
      finished: false,
    };

    const gw = normalizeGameweek(raw);
    assert.equal(gw.fplId, 1);
    assert.equal(gw.name, "Gameweek 1");
    assert.equal(gw.isCurrent, true);
    assert.equal(gw.isFinished, false);
    assert.equal(gw.deadline.toISOString(), "2025-08-15T17:30:00.000Z");
  });

  it("should normalize raw FPL fixture data", () => {
    const raw = {
      id: 10,
      event: 1,
      team_h: 1,
      team_a: 2,
      kickoff_time: "2025-08-16T14:00:00Z",
      started: true,
      finished: true,
      team_h_score: 2,
      team_a_score: 1,
      minutes: 90,
    };

    const fixture = normalizeFixture(raw);
    assert.equal(fixture.fplId, 10);
    assert.equal(fixture.gameweekFplId, 1);
    assert.equal(fixture.homeTeamFplId, 1);
    assert.equal(fixture.awayTeamFplId, 2);
    assert.equal(fixture.homeScore, 2);
    assert.equal(fixture.awayScore, 1);
    assert.equal(fixture.started, true);
    assert.equal(fixture.finished, true);
  });

  it("should normalize raw FPL live player statistics", () => {
    const raw = {
      id: 254,
      stats: {
        minutes: 90,
        goals_scored: 2,
        assists: 1,
        clean_sheets: 0,
        yellow_cards: 0,
        red_cards: 0,
        saves: 0,
        bonus: 3,
        total_points: 13,
      },
      explain: [
        {
          fixture: 12,
          stats: [
            { identifier: "minutes", points: 2, value: 90 },
            { identifier: "goals_scored", points: 8, value: 2 },
            { identifier: "assists", points: 3, value: 1 },
            { identifier: "bonus", points: 3, value: 3 }
          ]
        }
      ]
    };

    const statsArray = normalizePlayerStats(raw);
    assert.equal(statsArray.length, 1);
    const stats = statsArray[0];
    assert.equal(stats.playerFplId, 254);
    assert.equal(stats.fixtureFplId, 12);
    assert.equal(stats.minutes, 90);
    assert.equal(stats.goals, 2);
    assert.equal(stats.assists, 1);
    assert.equal(stats.cleanSheet, false);
    assert.equal(stats.bonus, 3);
    assert.equal(stats.totalPoints, 16); // 2 + 8 + 3 + 3 = 16 (test logic is just sum of points)
  });
});
