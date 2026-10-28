import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChipType, type PerformanceAnalytics } from "@/types";
import { buildPerformanceCsv, buildPerformanceJson } from "@/lib/performanceExport";

const analytics: PerformanceAnalytics = {
  squads: [{ id: "squad-1", name: 'O’Brien, "Captain"' }],
  squadId: "squad-1",
  summary: {
    gameweeksPlayed: 1,
    totalPoints: 82,
    averagePoints: 82,
    medianPoints: 82,
    standardDeviation: 0,
    bestGameweek: { gameweekId: 1, gameweekName: "Gameweek 1", points: 82 },
    worstGameweek: { gameweekId: 1, gameweekName: "Gameweek 1", points: 82 },
    recentForm: 82,
    gameweeksAboveAverage: 0,
    totalBenchPoints: 4,
    totalCaptainPoints: 16,
    totalTransferCost: 0,
    captainShare: 19.5,
  },
  history: [{
    gameweekId: 1,
    gameweekFplId: 1,
    gameweekName: "Gameweek 1",
    deadline: "2026-08-15T10:00:00.000Z",
    points: 82,
    rank: 3,
    benchPoints: 4,
    captainPoints: 16,
    transferCost: 0,
    transferCount: 2,
    cumulativePoints: 82,
    rollingAverage: 82,
    averagePoints: 80,
    cumulativeAveragePoints: 80,
    highestPoints: 110,
    differenceVsAverage: 2,
    chip: ChipType.WILDCARD,
  }],
  chips: [{ chipType: ChipType.WILDCARD, gameweekId: 1, gameweekName: "Gameweek 1" }],
};

describe("performance exports", () => {
  it("escapes squad names and exports the requested gameweek columns as CSV", () => {
    assert.equal(
      buildPerformanceCsv(analytics),
      '"squad_name","gameweek","points","rank","bench_points","captain_points","transfers","chip_used"\r\n' +
        '"O’Brien, ""Captain""","Gameweek 1","82","3","4","16","2","WILDCARD"'
    );
  });

  it("exports the full PerformanceAnalytics payload as formatted JSON", () => {
    const json = buildPerformanceJson(analytics);
    assert.deepEqual(JSON.parse(json), analytics);
    assert.match(json, /\n  "history": \[/);
  });
});
