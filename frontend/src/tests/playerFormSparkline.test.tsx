import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  analyseFormTrend,
  buildSparklinePath,
  computeSparklineCoordinates,
  formatSparklineTooltip,
  opponentByGameweekId,
  toFormTrendPoints,
  type FormTrendPoint,
  type PlayerGameweekStatInput,
} from "../lib/sparkline";
import { PlayerFormSparkline } from "../components/team/PlayerFormSparkline";
import type { Fixture } from "../types";

function point(overrides: Partial<FormTrendPoint> = {}): FormTrendPoint {
  return {
    gameweekId: 1,
    gameweekNumber: 1,
    gameweekName: "Gameweek 1",
    points: 0,
    opponent: null,
    ...overrides,
  };
}

function stat(overrides: Partial<PlayerGameweekStatInput> = {}): PlayerGameweekStatInput {
  return {
    gameweekId: 1,
    totalPoints: 0,
    gameweek: { id: 1, fplId: 1, name: "Gameweek 1" },
    ...overrides,
  };
}

describe("computeSparklineCoordinates", () => {
  it("returns no coordinates for an empty series", () => {
    assert.deepEqual(computeSparklineCoordinates([]), []);
  });

  it("centres a single point at mid height", () => {
    const [only] = computeSparklineCoordinates([7]);
    assert.equal(only.x, 100);
    assert.equal(only.y, 28);
  });

  it("spaces x evenly and puts larger values higher (smaller y)", () => {
    const coords = computeSparklineCoordinates([2, 4, 6, 8, 10]);
    assert.deepEqual(
      coords.map((c) => c.x),
      [6, 53, 100, 147, 194]
    );
    for (let i = 1; i < coords.length; i++) {
      assert.ok(coords[i].y < coords[i - 1].y, "y must fall as points rise");
    }
    assert.equal(coords[0].y, 48);
    assert.equal(coords[coords.length - 1].y, 8);
  });

  it("draws a flat mid-height line for all-equal points (no division by zero)", () => {
    const coords = computeSparklineCoordinates([5, 5, 5, 5, 5]);
    assert.ok(coords.every((c) => c.y === 28));
    assert.ok(coords.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)));
    assert.equal(buildSparklinePath(coords).includes("NaN"), false);
  });

  it("handles zero and negative points within the box", () => {
    const coords = computeSparklineCoordinates([-2, 0, -1, 3]);
    assert.ok(coords.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)));
    assert.ok(coords.every((c) => c.x >= 0 && c.x <= 200));
    assert.ok(coords.every((c) => c.y >= 0 && c.y <= 56));
    // The minimum (-2) sits at the bottom, the maximum (3) at the top.
    assert.equal(coords[0].y, 48);
    assert.equal(coords[3].y, 8);
  });

  it("works with fewer than 5 gameweeks", () => {
    const coords = computeSparklineCoordinates([1, 9]);
    assert.equal(coords.length, 2);
    assert.deepEqual(
      coords.map((c) => c.x),
      [6, 194]
    );
  });

  it("keeps every coordinate finite and inside the box", () => {
    const coords = computeSparklineCoordinates([0, 13, 2, 11, 5], 320, 56);
    assert.ok(coords.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)));
    assert.ok(coords.every((c) => c.x >= 0 && c.x <= 320));
    assert.ok(coords.every((c) => c.y >= 0 && c.y <= 56));
  });
});

describe("buildSparklinePath", () => {
  it("is empty for no coordinates", () => {
    assert.equal(buildSparklinePath([]), "");
  });

  it("moves to the first point then lines through the rest", () => {
    const path = buildSparklinePath(computeSparklineCoordinates([2, 4, 6, 8, 10]));
    assert.match(path, /^M6,48/);
    assert.equal((path.match(/L/g) || []).length, 4);
    assert.equal(path.includes("NaN"), false);
  });
});

describe("analyseFormTrend", () => {
  it("reports up with a positive delta and the window total", () => {
    const summary = analyseFormTrend([
      point({ points: 3 }),
      point({ points: 5 }),
      point({ points: 4 }),
      point({ points: 9 }),
      point({ points: 8 }),
    ]);
    assert.equal(summary.direction, "up");
    assert.equal(summary.delta, 5);
    assert.equal(summary.totalPoints, 29);
    assert.equal(summary.lastPoints, 8);
  });

  it("reports down with a negative delta", () => {
    const summary = analyseFormTrend([point({ points: 10 }), point({ points: 2 })]);
    assert.equal(summary.direction, "down");
    assert.equal(summary.delta, -8);
    assert.equal(summary.totalPoints, 12);
  });

  it("reports flat when first and last points are equal", () => {
    const summary = analyseFormTrend([
      point({ points: 6 }),
      point({ points: 2 }),
      point({ points: 6 }),
    ]);
    assert.equal(summary.direction, "flat");
    assert.equal(summary.delta, 0);
    assert.equal(summary.totalPoints, 14);
  });

  it("reports a flat zero summary with no data", () => {
    assert.deepEqual(analyseFormTrend([]), {
      direction: "flat",
      delta: 0,
      totalPoints: 0,
      lastPoints: null,
    });
  });
});

describe("toFormTrendPoints", () => {
  it("keeps the most recent 5 gameweeks, oldest first", () => {
    const stats = [7, 6, 5, 4, 3, 2, 1].map((gw) =>
      stat({
        gameweekId: gw,
        totalPoints: gw,
        gameweek: { id: gw, fplId: gw, name: `Gameweek ${gw}` },
      })
    );
    const points = toFormTrendPoints(stats);
    assert.deepEqual(
      points.map((p) => p.gameweekId),
      [3, 4, 5, 6, 7]
    );
    assert.deepEqual(
      points.map((p) => p.points),
      [3, 4, 5, 6, 7]
    );
  });

  it("keeps fewer than 5 gameweeks as-is", () => {
    const points = toFormTrendPoints([stat({ gameweekId: 2, totalPoints: 4 })]);
    assert.equal(points.length, 1);
    assert.equal(points[0].gameweekNumber, 1);
  });

  it("attaches the opponent when the lookup has it, null otherwise", () => {
    const opponents = new Map([[1, "vs ARS"]]);
    const points = toFormTrendPoints(
      [stat({ gameweekId: 1, totalPoints: 8 }), stat({ gameweekId: 2, totalPoints: 3 })],
      opponents
    );
    assert.equal(points[0].opponent, "vs ARS");
    assert.equal(points[1].opponent, null);
  });

  it("falls back to the gameweek id when gameweek details are missing", () => {
    const points = toFormTrendPoints([stat({ gameweekId: 9, totalPoints: 2, gameweek: null })]);
    assert.equal(points[0].gameweekNumber, null);
    assert.equal(points[0].gameweekName, "Gameweek 9");
  });

  it("drops stats with non-finite points instead of drawing them as zero", () => {
    const points = toFormTrendPoints([
      stat({ gameweekId: 1, totalPoints: 5 }),
      stat({ gameweekId: 2, totalPoints: Number.NaN }),
    ]);
    assert.deepEqual(
      points.map((p) => p.gameweekId),
      [1]
    );
  });
});

describe("opponentByGameweekId", () => {
  const fixture = (overrides: Partial<Fixture>): Fixture => ({
    id: 1,
    fplId: 1,
    gameweekId: 1,
    homeTeamId: 10,
    homeTeam: { id: 10, fplId: 10, name: "Arsenal", shortName: "ARS", logoUrl: null },
    awayTeamId: 20,
    awayTeam: { id: 20, fplId: 20, name: "Chelsea", shortName: "CHE", logoUrl: null },
    kickoffTime: null,
    started: false,
    finished: false,
    homeScore: null,
    awayScore: null,
    minutes: 0,
    ...overrides,
  });

  it("reads 'vs' for a home fixture and '@' for an away fixture", () => {
    const byGameweek = opponentByGameweekId(
      [
        fixture({ gameweekId: 12, homeTeamId: 10, awayTeamId: 20 }),
        fixture({
          id: 2,
          gameweekId: 13,
          homeTeamId: 20,
          homeTeam: { id: 20, fplId: 20, name: "Chelsea", shortName: "CHE", logoUrl: null },
          awayTeamId: 10,
          awayTeam: { id: 10, fplId: 10, name: "Arsenal", shortName: "ARS", logoUrl: null },
        }),
      ],
      10
    );
    assert.equal(byGameweek.get(12), "vs CHE");
    assert.equal(byGameweek.get(13), "@ CHE");
  });

  it("skips fixtures without a gameweek, without the team, or without a short name", () => {
    const byGameweek = opponentByGameweekId(
      [
        fixture({ gameweekId: null }),
        fixture({ gameweekId: 2, homeTeamId: 30, awayTeamId: 40 }),
        fixture({
          gameweekId: 3,
          homeTeamId: 10,
          awayTeam: { id: 20, fplId: 20, name: "Chelsea", shortName: "", logoUrl: null },
        }),
      ],
      10
    );
    assert.equal(byGameweek.size, 0);
  });
});

describe("formatSparklineTooltip", () => {
  it("shows gameweek number, opponent and points", () => {
    assert.equal(
      formatSparklineTooltip(point({ gameweekNumber: 12, opponent: "vs ARS", points: 8 })),
      "GW12 vs ARS · 8 pts"
    );
  });

  it("omits the opponent when it is unknown", () => {
    assert.equal(
      formatSparklineTooltip(point({ gameweekNumber: 12, opponent: null, points: 8 })),
      "GW12 · 8 pts"
    );
  });

  it("falls back to the gameweek name when the number is unknown", () => {
    assert.equal(
      formatSparklineTooltip(
        point({ gameweekNumber: null, gameweekName: "Gameweek 3", points: 2 })
      ),
      "Gameweek 3 · 2 pts"
    );
  });
});

describe("PlayerFormSparkline", () => {
  const fiveWeeks: FormTrendPoint[] = [
    point({ gameweekId: 8, gameweekNumber: 8, gameweekName: "Gameweek 8", points: 3, opponent: "vs ARS" }),
    point({ gameweekId: 9, gameweekNumber: 9, gameweekName: "Gameweek 9", points: 5, opponent: "@ CHE" }),
    point({ gameweekId: 10, gameweekNumber: 10, gameweekName: "Gameweek 10", points: 4, opponent: "vs LIV" }),
    point({ gameweekId: 11, gameweekNumber: 11, gameweekName: "Gameweek 11", points: 9, opponent: "@ MCI" }),
    point({ gameweekId: 12, gameweekNumber: 12, gameweekName: "Gameweek 12", points: 8, opponent: "vs TOT" }),
  ];

  it("renders an SVG with one titled dot per gameweek", () => {
    const markup = renderToStaticMarkup(<PlayerFormSparkline points={fiveWeeks} />);
    assert.match(markup, /data-testid="form-sparkline-svg"/);
    assert.equal((markup.match(/<circle/g) || []).length, 5);
    assert.match(markup, /GW8 vs ARS · 3 pts/);
    assert.match(markup, /GW12 vs TOT · 8 pts/);
    assert.match(markup, /<path[^>]*d="M/);
    assert.equal(markup.includes("NaN"), false);
  });

  it("shows the trend badge with direction, swing and window total", () => {
    const markup = renderToStaticMarkup(<PlayerFormSparkline points={fiveWeeks} />);
    assert.match(markup, /Improving \+5 · 29 pts/);
  });

  it("shows a declining badge when form falls", () => {
    const markup = renderToStaticMarkup(
      <PlayerFormSparkline
        points={[point({ points: 10 }), point({ points: 2 })]}
      />
    );
    assert.match(markup, /Declining -8 · 12 pts/);
  });

  it("renders a flat mid-height line with no NaN for all-equal points", () => {
    const flat = [1, 2, 3].map((gw) => point({ gameweekId: gw, points: 6 }));
    const markup = renderToStaticMarkup(<PlayerFormSparkline points={flat} />);
    assert.match(markup, /Steady 0 · 18 pts/);
    assert.equal(markup.includes("NaN"), false);
    assert.ok((markup.match(/cy="28"/g) || []).length >= 3);
  });

  it("renders the empty state without an SVG", () => {
    const markup = renderToStaticMarkup(<PlayerFormSparkline points={[]} />);
    assert.match(markup, /No recent gameweek data yet/);
    assert.doesNotMatch(markup, /form-sparkline-svg/);
  });

  it("renders a same-height skeleton while loading", () => {
    const markup = renderToStaticMarkup(<PlayerFormSparkline points={[]} loading />);
    assert.match(markup, /data-testid="form-sparkline-loading"/);
    assert.doesNotMatch(markup, /form-sparkline-svg/);
    assert.doesNotMatch(markup, /No recent gameweek data yet/);
  });

  it("exposes an accessible summary instead of a bare graphic", () => {
    const markup = renderToStaticMarkup(<PlayerFormSparkline points={fiveWeeks} />);
    assert.match(markup, /Form over the last 5 gameweeks/);
    assert.match(markup, /Total 29 points, trend improving/);
  });
});
