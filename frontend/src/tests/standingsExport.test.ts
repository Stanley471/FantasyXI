import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MembershipStatus, type LeagueStandingsEntry } from "@/types";
import {
  toStandingsExportRows,
  buildStandingsCsv,
  buildStandingsJson,
  buildStandingsExportFilename,
} from "@/lib/standingsExport";

const standings: LeagueStandingsEntry[] = [
  {
    rank: 1,
    userId: "user-1",
    username: 'O\'Brien, "Captain"',
    squadId: "squad-1",
    squadName: "Red, White & Blue XI",
    membershipStatus: MembershipStatus.ACTIVE,
    totalPoints: 210,
    bestGameweekPoints: 82,
    gameweekScores: [],
    joinedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    rank: 2,
    userId: "user-2",
    username: "Second Manager",
    squadId: "squad-2",
    squadName: "Simple Squad",
    membershipStatus: MembershipStatus.PENDING,
    totalPoints: 190,
    bestGameweekPoints: 70,
    gameweekScores: [],
    joinedAt: "2026-08-02T00:00:00.000Z",
  },
];

describe("league standings exports (issue #498)", () => {
  it("falls back to best gameweek points when no live points are provided", () => {
    const rows = toStandingsExportRows(standings);
    assert.deepEqual(rows, [
      { rank: 1, managerName: standings[0].username, squadName: standings[0].squadName, gameweekPoints: 82, totalPoints: 210 },
      { rank: 2, managerName: standings[1].username, squadName: standings[1].squadName, gameweekPoints: 70, totalPoints: 190 },
    ]);
  });

  it("prefers live gameweek points over the best recorded score", () => {
    const rows = toStandingsExportRows(standings, { "user-1": 15, "user-2": 9 });
    assert.deepEqual(rows.map((r) => r.gameweekPoints), [15, 9]);
  });

  it("escapes quotes and commas in manager/squad names in the CSV output", () => {
    const rows = toStandingsExportRows(standings);
    assert.equal(
      buildStandingsCsv(rows),
      '"rank","manager_name","squad_name","gameweek_points","total_points"\r\n' +
        '"1","O\'Brien, ""Captain""","Red, White & Blue XI","82","210"\r\n' +
        '"2","Second Manager","Simple Squad","70","190"'
    );
  });

  it("exports the same rows as formatted JSON", () => {
    const rows = toStandingsExportRows(standings);
    const json = buildStandingsJson(rows);
    assert.deepEqual(JSON.parse(json), rows);
    assert.match(json, /\n {2}\{/);
  });

  it("builds a filename including the league name and a current timestamp", () => {
    const now = new Date("2026-11-20T18:30:45.000Z");
    const filename = buildStandingsExportFilename("Office League, 2026!", "Gameweek 12", "csv", now);
    assert.equal(filename, "office-league-2026-standings-gameweek-12-2026-11-20T18-30-45-000Z.csv");
  });

  it("omits the gameweek segment when no label is available", () => {
    const now = new Date("2026-11-20T18:30:45.000Z");
    const filename = buildStandingsExportFilename("Sunday League", null, "json", now);
    assert.equal(filename, "sunday-league-standings-2026-11-20T18-30-45-000Z.json");
  });
});
