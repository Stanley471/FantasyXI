import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_RADAR_MANAGERS,
  RADAR_DIMENSIONS,
  axisAngle,
  axisEndpoint,
  gridRingPoints,
  interpolateNormalized,
  leagueAverageRadarValues,
  managerRadarValues,
  normalizeAllDimensions,
  normalizeDimension,
  percentileExplanation,
  percentileLabel,
  percentileRank,
  polygonPointsAttr,
  radarPoint,
  radarPolygonPoints,
  toggleManagerIds,
} from "../lib/radar";
import { GameweekRadarChart, RadarManagerSeries } from "../components/analytics/GameweekRadarChart";
import type { GameweekPerformance } from "../types";

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length;
}

/** Text content of every cell in the table body, row by row */
function tableRows(html: string): string[][] {
  const body = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, cell]) => cell.replace(/<[^>]+>/g, ""))
  );
}

function gw(fplId: number, extra: Partial<GameweekPerformance> = {}): GameweekPerformance {
  return {
    gameweekId: fplId,
    gameweekFplId: fplId,
    gameweekName: `Gameweek ${fplId}`,
    deadline: "2026-08-15T10:00:00.000Z",
    points: 60,
    rank: null,
    benchPoints: 0,
    captainPoints: 0,
    transferCost: 0,
    transferCount: 0,
    cumulativePoints: 60,
    rollingAverage: 60,
    averagePoints: 50,
    cumulativeAveragePoints: 50,
    highestPoints: 100,
    differenceVsAverage: 10,
    chip: null,
    ...extra,
  };
}

describe("Radar dimensions", () => {
  it("defines exactly six dimensions with unique ids and labels", () => {
    assert.equal(RADAR_DIMENSIONS.length, 6);
    assert.deepEqual(
      RADAR_DIMENSIONS.map((d) => d.id),
      ["attack", "defense", "captain", "bench", "transfers", "form"]
    );
    assert.equal(new Set(RADAR_DIMENSIONS.map((d) => d.label)).size, 6);
    assert.ok(RADAR_DIMENSIONS.every((d) => d.description.length > 0));
  });

  it("maps each dimension to a real GameweekPerformance field", () => {
    const entry = gw(1, { points: 80, captainPoints: 24, benchPoints: 2, transferCost: 4, rollingAverage: 70 });
    assert.deepEqual(
      RADAR_DIMENSIONS.map((d) => d.valueOf(entry)),
      [80, 56, 24, 2, 4, 70]
    );
    // Defense is the XI without the captain multiplier; bench and transfers
    // are lower-is-better, everything else higher-is-better.
    assert.deepEqual(
      RADAR_DIMENSIONS.map((d) => d.higherIsBetter),
      [true, true, true, false, false, true]
    );
  });

  it("derives raw values for one gameweek, a season average, or nothing", () => {
    const gw1 = gw(1, { points: 80, captainPoints: 24, benchPoints: 2, transferCost: 0, rollingAverage: 70 });
    const gw2 = gw(2, { points: 60, captainPoints: 12, benchPoints: 9, transferCost: 4, rollingAverage: 55 });
    assert.deepEqual(managerRadarValues([gw1, gw2], 1), [80, 56, 24, 2, 0, 70]);
    assert.deepEqual(managerRadarValues([gw1, gw2], 2), [60, 48, 12, 9, 4, 55]);
    // Season average across both gameweeks
    assert.deepEqual(managerRadarValues([gw1, gw2]), [70, 52, 18, 5.5, 2, 62.5]);
    assert.deepEqual(managerRadarValues([], 1), [null, null, null, null, null, null]);
    assert.deepEqual(managerRadarValues([gw1], 99), [null, null, null, null, null, null]);
  });

  it("fills the league average only where the API publishes one", () => {
    const entry = gw(1, { averagePoints: 50 });
    assert.deepEqual(leagueAverageRadarValues(entry), [50, null, null, null, null, 50]);
    assert.deepEqual(leagueAverageRadarValues(null), [null, null, null, null, null, null]);
  });
});

describe("Radar normalization and scaling", () => {
  it("min-max normalizes one dimension, best to 1 and worst to 0", () => {
    assert.deepEqual(normalizeDimension([10, 20, 30], true), [0, 0.5, 1]);
    assert.deepEqual(normalizeDimension([10, 20, 30], false), [1, 0.5, 0]);
    assert.deepEqual(normalizeDimension([null, 10, 20], true), [null, 0, 1]);
    assert.deepEqual(normalizeDimension([null, null], true), [null, null]);
  });

  it("maps a cohort with no spread to the neutral middle ring", () => {
    assert.deepEqual(normalizeDimension([50, 50, 50], true), [0.5, 0.5, 0.5]);
    assert.deepEqual(normalizeDimension([7], false), [0.5]);
  });

  it("normalizes every dimension against the managers plus the league average", () => {
    const a = [80, 60, 24, 2, 0, 70];
    const b = [60, 45, 12, 9, 4, 55];
    const average = [50, null, null, null, null, 50];
    assert.deepEqual(normalizeAllDimensions([a, b], average), [
      [1, 1, 1, 1, 1, 1],
      [0.33, 0, 0, 0, 0, 0.25],
    ]);
  });
});

describe("Radar polygon math", () => {
  const center = { x: 320, y: 210 };

  it("points the first axis straight up and spaces axes evenly", () => {
    assert.equal(axisAngle(0), -Math.PI / 2);
    assert.ok(Math.abs(axisAngle(1) - -Math.PI / 6) < 1e-12);
    assert.ok(Math.abs(axisAngle(3) - Math.PI / 2) < 1e-12);
  });

  it("maps values to cartesian points on the right axis", () => {
    assert.deepEqual(radarPoint(1, 0, 100, { x: 0, y: 0 }), { x: 0, y: -100 });
    assert.deepEqual(radarPoint(1, 3, 100, { x: 0, y: 0 }), { x: 0, y: 100 });
    assert.deepEqual(radarPoint(0.5, 0, 100, { x: 0, y: 0 }), { x: 0, y: -50 });
    assert.deepEqual(radarPoint(0, 2, 100, { x: 10, y: 20 }), { x: 10, y: 20 });
    assert.deepEqual(radarPoint(null, 2, 100, { x: 10, y: 20 }), { x: 10, y: 20 });
    assert.deepEqual(axisEndpoint(0, 100, { x: 0, y: 0 }), { x: 0, y: -100 });
  });

  it("builds a regular hexagon for equal mid-ring values (golden geometry)", () => {
    const points = radarPolygonPoints([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 154, center);
    assert.equal(
      polygonPointsAttr(points),
      "320,133 386.68,171.5 386.68,248.5 320,287 253.32,248.5 253.32,171.5"
    );
  });

  it("builds the outer grid ring at the full radius", () => {
    assert.equal(
      polygonPointsAttr(gridRingPoints(1, 154, center)),
      "320,56 453.37,133 453.37,287 320,364 186.63,287 186.63,133"
    );
    assert.equal(
      polygonPointsAttr(gridRingPoints(0.5, 154, center)),
      "320,133 386.68,171.5 386.68,248.5 320,287 253.32,248.5 253.32,171.5"
    );
  });

  it("interpolates between shapes for the gameweek transition", () => {
    assert.deepEqual(interpolateNormalized([0, 1, null], [1, 0, 0.5], 0.5), [0.5, 0.5, 0.25]);
    // At t=0 the appearing value sits at the centre (0); at t=1 it is fully in
    assert.deepEqual(interpolateNormalized([0, 1, null], [1, 0, 0.5], 0), [0, 1, 0]);
    assert.deepEqual(interpolateNormalized([0, 1, null], [1, 0, 0.5], 1), [1, 0, 0.5]);
    // A value appearing mid-transition fades in from the centre
    assert.deepEqual(interpolateNormalized([null], [0.8], 0.5), [0.4]);
    assert.deepEqual(interpolateNormalized([0.8], [null], 0.5), [0.4]);
  });
});

describe("Percentiles relative to the league average", () => {
  it("ranks a value against the cohort, direction aware", () => {
    assert.equal(percentileRank(80, [80, 60, 50], true), 100);
    assert.equal(percentileRank(60, [80, 60, 50], true), 50);
    assert.equal(percentileRank(50, [80, 60, 50], true), 0);
    // Lower is better: fewest bench points ranks first
    assert.equal(percentileRank(2, [2, 9, null], false), 100);
    assert.equal(percentileRank(9, [2, 9, null], false), 0);
    // Ties count as half a win
    assert.equal(percentileRank(60, [60, 60, 50], true), 75);
  });

  it("returns null with no value or nothing to compare against", () => {
    assert.equal(percentileRank(null, [80, 60], true), null);
    assert.equal(percentileRank(80, [80], true), null);
    assert.equal(percentileRank(80, [], true), null);
  });

  it("labels percentiles with ordinals", () => {
    assert.equal(percentileLabel(1), "1st");
    assert.equal(percentileLabel(2), "2nd");
    assert.equal(percentileLabel(3), "3rd");
    assert.equal(percentileLabel(11), "11th");
    assert.equal(percentileLabel(22), "22nd");
    assert.equal(percentileLabel(75), "75th");
    assert.equal(percentileLabel(100), "100th");
  });

  it("explains the percentile, the cohort size and the league average", () => {
    const dimension = RADAR_DIMENSIONS[0]; // attack
    const text = percentileExplanation(dimension, 78, 52, 75, 4);
    assert.match(text, /75th percentile/);
    assert.match(text, /among the 4 values compared/);
    assert.match(text, /league average is 52 points/);
    assert.match(text, /higher is better/);
    assert.match(percentileExplanation(RADAR_DIMENSIONS[3], 2, null, 100, 3), /lower is better/);
    assert.match(percentileExplanation(dimension, null, 52, null, 4), /no data/);
  });
});

describe("Manager toggling", () => {
  it("adds and removes managers and caps the comparison at four", () => {
    assert.equal(MAX_RADAR_MANAGERS, 4);
    assert.deepEqual(toggleManagerIds([], "a"), ["a"]);
    assert.deepEqual(toggleManagerIds(["a", "b"], "a"), ["b"]);
    assert.deepEqual(toggleManagerIds(["a", "b", "c", "d"], "e"), ["a", "b", "c", "d"]);
    assert.deepEqual(toggleManagerIds(["a", "b", "c", "d"], "d"), ["a", "b", "c"]);
  });
});

describe("GameweekRadarChart", () => {
  const solo: RadarManagerSeries[] = [
    { id: "a", label: "Invincibles", values: [50, 50, 50, 50, 50, 50] },
  ];
  const two: RadarManagerSeries[] = [
    { id: "a", label: "Invincibles", values: [80, 60, 24, 2, 0, 70] },
    { id: "b", label: "Cannon Fodder", values: [60, 45, 12, 9, 4, 55] },
  ];
  const average = [50, null, null, null, null, 50];

  it("plots one polygon per selected manager on the same canvas", () => {
    const html = renderToStaticMarkup(
      <GameweekRadarChart
        title="Live gameweek radar"
        summary="Two managers compared across six tactical dimensions."
        gameweekLabel="Gameweek 12"
        managers={two}
        leagueAverage={average}
        animationDurationMs={0}
      />
    );
    assert.equal(count(html, /<polygon[^>]*>/g), 4 + 2); // 4 grid rings + 2 managers
    assert.equal(count(html, /<g data-series=/g), 2);
    assert.match(html, /Gameweek 12/);
  });

  it("renders the golden hexagon when every value normalizes to the middle ring", () => {
    const html = renderToStaticMarkup(
      <GameweekRadarChart
        title="Live gameweek radar"
        summary="One manager, all values equal."
        gameweekLabel="Gameweek 1"
        managers={solo}
        animationDurationMs={0}
      />
    );
    // Visual-regression proxy: deterministic SVG output for a fixed input
    assert.match(html, /points="320,133 386\.68,171\.5 386\.68,248\.5 320,287 253\.32,248\.5 253\.32,171\.5"/);
    assert.match(html, /points="320,56 453\.37,133 453\.37,287 320,364 186\.63,287 186\.63,133"/);
  });

  it("marks the league average with a diamond on each axis that has one", () => {
    const html = renderToStaticMarkup(
      <GameweekRadarChart
        title="Live gameweek radar"
        summary="Summary"
        gameweekLabel="Gameweek 12"
        managers={two}
        leagueAverage={average}
        animationDurationMs={0}
      />
    );
    // Attack and form have a league average; the other four dimensions do not
    assert.equal(count(html, /<rect[^>]*width="8"/g), 2);
    assert.match(html, /League average attack: 50 points/);
  });

  it("toggles managers on and off and caps the comparison at four", () => {
    const five: RadarManagerSeries[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      label: `Manager ${id.toUpperCase()}`,
      values: [50, 50, 50, 50, 50, 50],
    }));
    const html = renderToStaticMarkup(
      <GameweekRadarChart
        title="Live gameweek radar"
        summary="Summary"
        gameweekLabel="All gameweeks"
        managers={five}
        animationDurationMs={0}
      />
    );
    assert.equal(count(html, /<g data-series=/g), 4);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /<button[^>]*disabled/);
    assert.match(html, /Only 4 managers can be compared at once/);

    const subset = renderToStaticMarkup(
      <GameweekRadarChart
        title="Live gameweek radar"
        summary="Summary"
        gameweekLabel="All gameweeks"
        managers={two}
        initialSelectedIds={["b"]}
        animationDurationMs={0}
      />
    );
    assert.equal(count(subset, /<g data-series=/g), 1);
    assert.match(subset, /data-series="b"/);
    assert.doesNotMatch(subset, /data-series="a"/);
  });

  it("exposes a labelled image, keyboard group and text summary", () => {
    const html = renderToStaticMarkup(
      <GameweekRadarChart
        title="Live gameweek radar"
        summary="Two managers compared across six tactical dimensions."
        gameweekLabel="Gameweek 12"
        managers={two}
        animationDurationMs={0}
      />
    );
    assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Live gameweek radar — Gameweek 12\. Two managers compared/);
    assert.match(html, /role="group"[^>]*aria-label="Live gameweek radar\. Use the left and right arrow keys/);
    assert.match(html, /tabindex="0"/);
    assert.match(html, /<p id="[^"]+" class="sr-only">Two managers compared across six tactical dimensions\.<\/p>/);
    assert.match(html, /aria-live="polite"/);
    // No tooltip is open until a dimension is hovered or arrowed to
    assert.doesNotMatch(html, /percentile among/);
  });

  it("renders every dimension, value and percentile in an accessible table", () => {
    const html = renderToStaticMarkup(
      <GameweekRadarChart
        title="Live gameweek radar"
        summary="Summary"
        gameweekLabel="Gameweek 12"
        managers={two}
        leagueAverage={average}
        animationDurationMs={0}
      />
    );
    assert.deepEqual(tableRows(html), [
      ["Attack", "80 (100th pct)", "60 (50th pct)", "50"],
      ["Defense", "60 (100th pct)", "45 (0th pct)", "—"],
      ["Captain effectiveness", "24 (100th pct)", "12 (0th pct)", "—"],
      ["Bench efficiency", "2 (100th pct)", "9 (0th pct)", "—"],
      ["Transfer ROI", "0 (100th pct)", "4 (0th pct)", "—"],
      ["Recent form", "70 (100th pct)", "55 (50th pct)", "50"],
    ]);
    assert.match(html, /<caption class="sr-only">Live gameweek radar — Gameweek 12<\/caption>/);
  });

  it("renders an empty state without polygons or focus stops", () => {
    const html = renderToStaticMarkup(
      <GameweekRadarChart
        title="Live gameweek radar"
        summary="Summary"
        gameweekLabel="Gameweek 12"
        managers={[]}
        animationDurationMs={0}
      />
    );
    assert.match(html, /No managers to compare yet\./);
    assert.doesNotMatch(html, /<polygon/);
    assert.doesNotMatch(html, /tabindex/);
  });
});
