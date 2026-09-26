import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  bandIndexAt,
  buildColumnPath,
  buildLinePath,
  formatPoints,
  labelInterval,
  linearScale,
  niceTicks,
} from "../lib/chart";
import { TimeSeriesChart, ChartSeries } from "../components/analytics/TimeSeriesChart";
import { PerformanceDashboard, shortGameweekLabel } from "../components/analytics/PerformanceDashboard";
import type { GameweekPerformance, PerformanceAnalytics } from "../types";

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

describe("Chart geometry", () => {
  it("produces nice ticks that include a zero baseline", () => {
    assert.deepEqual(niceTicks(12, 87), [0, 25, 50, 75, 100]);
    assert.deepEqual(niceTicks(0, 9), [0, 2.5, 5, 7.5, 10]);
    assert.deepEqual(niceTicks(-8, 30), [-10, 0, 10, 20, 30]);
    assert.deepEqual(niceTicks(0, 0), [0, 1]);
  });

  it("maps values linearly and inverts the y range", () => {
    const y = linearScale([0, 100], [200, 0]);
    assert.equal(y(0), 200);
    assert.equal(y(50), 100);
    assert.equal(y(100), 0);
    assert.deepEqual(y.domain, [0, 100]);
  });

  it("breaks a line at missing values instead of drawing them as zero", () => {
    const path = buildLinePath([
      { x: 0, y: 10 },
      { x: 10, y: 20 },
      { x: 20, y: null },
      { x: 30, y: 5 },
    ]);
    assert.equal(path, "M0,10L10,20M30,5");
    assert.equal(buildLinePath([{ x: 0, y: null }]), "");
  });

  it("rounds the data end of a column and keeps the baseline square", () => {
    const up = buildColumnPath(10, 20, 100, 40);
    assert.ok(up.startsWith("M10,100 L10,44 Q10,40 14,40"), up);
    assert.ok(up.includes("L30,100"), up);

    // Negative values grow downwards from the baseline
    const down = buildColumnPath(10, 20, 100, 130);
    assert.ok(down.startsWith("M10,100 L10,126 Q10,130 14,130"), down);

    assert.equal(buildColumnPath(10, 20, 100, 100), "");
  });

  it("thins axis labels so they never overlap", () => {
    assert.equal(labelInterval(10, 600), 1);
    assert.equal(labelInterval(38, 300), 5);
    assert.equal(labelInterval(0, 300), 1);
  });

  it("snaps a pointer position to the nearest band", () => {
    assert.equal(bandIndexAt(45, 40, 10, 5), 0);
    assert.equal(bandIndexAt(71, 40, 10, 5), 3);
    assert.equal(bandIndexAt(500, 40, 10, 5), 4);
    assert.equal(bandIndexAt(0, 40, 10, 5), 0);
    assert.equal(bandIndexAt(10, 0, 10, 0), -1);
  });

  it("formats points with one decimal at most and a dash for missing data", () => {
    assert.equal(formatPoints(1284), "1,284");
    assert.equal(formatPoints(62.26), "62.3");
    assert.equal(formatPoints(-4), "-4");
    assert.equal(formatPoints(null), "—");
  });
});

describe("TimeSeriesChart", () => {
  const categories = ["Gameweek 1", "Gameweek 2", "Gameweek 3"];
  const you: ChartSeries = { id: "you", label: "You", color: "#3987e5", kind: "column", values: [52, 71, 38] };
  const average: ChartSeries = { id: "average", label: "Platform average", color: "#d95926", kind: "line", values: [48.5, null, 41] };

  it("renders one column per value and a line for each line series", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart title="Points per gameweek" summary="Summary" categories={categories} series={[you, average]} />
    );
    assert.equal(count(html, /<path[^>]*data-series="you"/g), 3);
    assert.equal(count(html, /<g data-series="average"/g), 1);
  });

  it("renders every data point in an accessible table, including missing values", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart title="Points per gameweek" summary="Summary" categories={categories} series={[you, average]} />
    );
    assert.deepEqual(tableRows(html), [
      ["Gameweek 1", "52", "48.5"],
      ["Gameweek 2", "71", "—"],
      ["Gameweek 3", "38", "41"],
    ]);
    assert.match(html, /<caption class="sr-only">Points per gameweek<\/caption>/);
    assert.match(html, /<th scope="col"[^>]*>Platform average<\/th>/);
  });

  it("exposes a keyboard-focusable, labelled chart with a text summary", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart title="Points over time" summary="You finished 40 points above average." categories={categories} series={[you]} />
    );
    assert.match(html, /<figure[^>]*aria-labelledby=/);
    assert.match(html, /role="group"[^>]*aria-label="Points over time\. Use the left and right arrow keys/);
    assert.match(html, /tabindex="0"/);
    assert.match(html, /<p id="[^"]+" class="sr-only">You finished 40 points above average\.<\/p>/);
    assert.match(html, /aria-live="polite"/);
    // The decorative SVG is hidden; the summary and table carry the content
    assert.match(html, /<svg[^>]*aria-hidden="true"/);
  });

  it("shows a legend for two or more series only", () => {
    const withLegend = renderToStaticMarkup(
      <TimeSeriesChart title="A" summary="S" categories={categories} series={[you, average]} />
    );
    const withoutLegend = renderToStaticMarkup(<TimeSeriesChart title="A" summary="S" categories={categories} series={[you]} />);
    assert.match(withLegend, /aria-label="A legend"/);
    assert.doesNotMatch(withoutLegend, /aria-label="A legend"/);
  });

  it("renders negative values below the zero baseline", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        title="Hits"
        summary="S"
        categories={categories}
        series={[{ ...you, values: [10, -4, 6] }]}
      />
    );
    assert.match(html, />-5<\/text>/);
    assert.equal(count(html, /<path[^>]*data-series="you"/g), 3);
  });

  it("renders an empty chart without focus stops when there is no data", () => {
    const html = renderToStaticMarkup(<TimeSeriesChart title="Empty" summary="No data" categories={[]} series={[]} />);
    assert.doesNotMatch(html, /tabindex/);
    assert.deepEqual(tableRows(html), []);
  });
});

function gameweek(fplId: number, points: number, extra: Partial<GameweekPerformance> = {}): GameweekPerformance {
  return {
    gameweekId: fplId,
    gameweekFplId: fplId,
    gameweekName: `Gameweek ${fplId}`,
    deadline: "2026-08-15T10:00:00.000Z",
    points,
    benchPoints: 0,
    captainPoints: 0,
    transferCost: 0,
    cumulativePoints: 0,
    rollingAverage: points,
    averagePoints: 50,
    cumulativeAveragePoints: 50 * fplId,
    highestPoints: 100,
    differenceVsAverage: points - 50,
    chip: null,
    ...extra,
  };
}

const analytics: PerformanceAnalytics = {
  squads: [{ id: "squad-1", name: "Invincibles" }],
  squadId: "squad-1",
  summary: {
    gameweeksPlayed: 3,
    totalPoints: 183,
    averagePoints: 61,
    medianPoints: 58,
    standardDeviation: 12.4,
    bestGameweek: { gameweekId: 2, gameweekName: "Gameweek 2", points: 78 },
    worstGameweek: { gameweekId: 3, gameweekName: "Gameweek 3", points: 47 },
    recentForm: 61,
    gameweeksAboveAverage: 2,
    totalBenchPoints: 14,
    totalCaptainPoints: 36,
    totalTransferCost: 4,
    captainShare: 19.7,
  },
  history: [
    gameweek(1, 58, { cumulativePoints: 58, benchPoints: 6 }),
    gameweek(2, 78, { cumulativePoints: 136, benchPoints: 8, chip: "TRIPLE_CAPTAIN" }),
    gameweek(3, 47, { cumulativePoints: 183, transferCost: 4 }),
  ],
  chips: [{ chipType: "TRIPLE_CAPTAIN", gameweekId: 2, gameweekName: "Gameweek 2" }],
};

describe("PerformanceDashboard", () => {
  const html = renderToStaticMarkup(<PerformanceDashboard analytics={analytics} />);

  it("renders the headline season statistics", () => {
    const tiles = [...html.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, label, value]) => [label, value]);
    assert.deepEqual(tiles, [
      ["Total points", "183"],
      ["Average per gameweek", "61"],
      ["Best gameweek", "78"],
      ["Recent form", "61"],
      ["Beat the average", "2/3"],
      ["Consistency", "±12.4"],
      ["Captaincy bonus", "36"],
      ["Points on bench", "14"],
    ]);
  });

  it("charts historical points over time against the platform average", () => {
    assert.match(html, />Points over time<\/h3>/);
    assert.match(html, />Points per gameweek<\/h3>/);
    assert.match(html, />Points left on the bench and transfer hits<\/h3>/);
    assert.match(html, /Cumulative points over 3 gameweeks, reaching 183 points, 33 points above the platform average\./);
  });

  it("puts the cumulative history in the first chart's data table", () => {
    const firstTable = html.slice(html.indexOf("<table"), html.indexOf("</table>") + 8);
    assert.deepEqual(tableRows(firstTable), [
      ["Gameweek 1", "58", "50"],
      ["Gameweek 2", "136", "100"],
      ["Gameweek 3", "183", "150"],
    ]);
  });

  it("uses compact gameweek labels on the x-axis", () => {
    assert.match(html, />GW1<\/text>/);
    assert.match(html, />GW3<\/text>/);
    assert.equal(shortGameweekLabel("Gameweek 12", 12), "GW12");
    assert.equal(shortGameweekLabel("Final Day", 38), "Final Day");
  });

  it("lists chips with the score achieved in that gameweek", () => {
    assert.match(html, /Triple Captain<\/span><span class="text-slate-400">Gameweek 2<\/span>/);
    assert.match(html, />78 pts<\/span>/);
  });

  it("explains when no chips have been played", () => {
    const empty = renderToStaticMarkup(<PerformanceDashboard analytics={{ ...analytics, chips: [] }} />);
    assert.match(empty, /No chips played yet this season\./);
  });
});
