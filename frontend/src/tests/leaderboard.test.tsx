import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import axe from "axe-core";
import { buildLeaderboardQuery, ordinal, resultRangeText, visiblePages } from "../lib/leaderboard";
import { LeaderboardTable } from "../components/leaderboard/LeaderboardTable";
import { Pagination } from "../components/leaderboard/Pagination";
import type { LeaderboardEntry } from "../types";

/**
 * Runs an axe-core accessibility audit on rendered markup.
 *
 * Colour contrast is excluded because jsdom does not apply the Tailwind
 * stylesheet or compute layout; contrast is covered by the design tokens used
 * (slate-300/400 text on slate-900/950 surfaces, all above 4.5:1).
 */
async function auditAccessibility(markup: string): Promise<axe.Result[]> {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title>Leaderboard</title></head><body><main>${markup}</main></body></html>`,
    { runScripts: "outside-only" }
  );
  dom.window.eval(axe.source);
  const windowAxe = (dom.window as unknown as { axe: typeof axe }).axe;
  const results = await windowAxe.run(dom.window.document, {
    rules: { "color-contrast": { enabled: false } },
  });
  dom.window.close();
  return results.violations;
}

function formatViolations(violations: axe.Result[]): string {
  return violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.html).join(", ")})`).join("\n");
}

function entry(rank: number, name: string, points: number, extra: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    rank,
    squadId: `squad-${name}`,
    squadName: `${name} FC`,
    userId: `user-${name}`,
    username: name.toLowerCase(),
    points,
    isCurrentUser: false,
    ...extra,
  };
}

const ENTRIES = [
  entry(1, "Alice", 310),
  entry(2, "Bob", 295),
  entry(2, "Carol", 295, { isCurrentUser: true }),
  entry(4, "Dave", 280),
  entry(5, "Averyveryveryverylongsquadnamewithoutanyspaces", 1204),
];

describe("Leaderboard helpers", () => {
  it("builds query strings, omitting empty search and season mode", () => {
    assert.equal(buildLeaderboardQuery({ page: 2, pageSize: 25 }), "?page=2&pageSize=25");
    assert.equal(
      buildLeaderboardQuery({ page: 1, pageSize: 25, search: "  Salah & Co ", gameweekId: 7 }),
      "?page=1&pageSize=25&q=Salah+%26+Co&gameweekId=7"
    );
    assert.equal(buildLeaderboardQuery({ page: 1, pageSize: 10, search: "   ", gameweekId: null }), "?page=1&pageSize=10");
  });

  it("shows first, last and neighbouring pages with ellipses", () => {
    assert.deepEqual(visiblePages(1, 1), [1]);
    assert.deepEqual(visiblePages(1, 5), [1, 2, "ellipsis-end", 5]);
    assert.deepEqual(visiblePages(3, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(visiblePages(10, 20), [1, "ellipsis-start", 9, 10, 11, "ellipsis-end", 20]);
    assert.deepEqual(visiblePages(20, 20), [1, "ellipsis-start", 19, 20]);
    assert.deepEqual(visiblePages(1, 0), []);
  });

  it("describes the visible range of results", () => {
    assert.equal(resultRangeText(1, 25, 1204), "Showing 1–25 of 1,204 managers");
    assert.equal(resultRangeText(49, 25, 1204), "Showing 1,201–1,204 of 1,204 managers");
    assert.equal(resultRangeText(1, 25, 1), "Showing 1–1 of 1 manager");
    assert.equal(resultRangeText(1, 25, 0), "No managers to show");
    assert.equal(resultRangeText(9, 25, 30), "No managers on this page (30 in total)");
  });

  it("formats ordinals", () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 1203].map(ordinal), [
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th", "1,203rd",
    ]);
  });
});

describe("LeaderboardTable", () => {
  const html = renderToStaticMarkup(
    <LeaderboardTable entries={ENTRIES} caption="Global leaderboard ranked by season points" pointsLabel="Season points" />
  );

  it("is a semantic table with a caption, column headers and sort state", () => {
    assert.match(html, /<caption class="sr-only">Global leaderboard ranked by season points<\/caption>/);
    assert.equal((html.match(/<th scope="col"/g) ?? []).length, 3);
    assert.match(html, /<th scope="col" aria-sort="descending"[^>]*>Season points<\/th>/);
    const body = html.slice(html.indexOf("<tbody"));
    assert.equal((body.match(/<tr[ >]/g) ?? []).length, ENTRIES.length);
  });

  it("announces ranks and ties in words, not just symbols", () => {
    assert.match(html, /<span class="sr-only">1st<\/span><span aria-hidden="true">1<\/span>/);
    assert.equal((html.match(/<span class="sr-only">Joint 2nd<\/span><span aria-hidden="true">=2<\/span>/g) ?? []).length, 2);
    assert.match(html, /<span class="sr-only">4th<\/span>/);
  });

  it("marks the signed-in manager's row with visible text", () => {
    assert.match(html, /<tr data-current-user="true"[^>]*>[\s\S]*?Carol FC<\/span><span[^>]*>You<\/span>/);
    assert.equal((html.match(/>You<\/span>/g) ?? []).length, 1);
  });

  it("wraps long names instead of clipping them and formats large totals", () => {
    assert.match(html, /\[overflow-wrap:anywhere\][^>]*>Averyveryveryverylongsquadnamewithoutanyspaces FC/);
    assert.doesNotMatch(html, /truncate/);
    assert.match(html, />1,204<\/td>/);
  });

  it("passes an automated accessibility audit", async () => {
    const violations = await auditAccessibility(html);
    assert.equal(violations.length, 0, formatViolations(violations));
  });
});

describe("Pagination", () => {
  const noop = () => {};

  it("renders nothing for a single page", () => {
    assert.equal(renderToStaticMarkup(<Pagination page={1} totalPages={1} onPageChange={noop} />), "");
  });

  it("is a labelled navigation landmark marking the current page", () => {
    const html = renderToStaticMarkup(<Pagination label="Leaderboard pages" page={10} totalPages={20} onPageChange={noop} />);
    assert.match(html, /<nav aria-label="Leaderboard pages"/);
    assert.match(html, /aria-current="page" aria-label="Page 10"/);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    assert.match(html, /Page 10 of 20/);
    assert.equal((html.match(/<li aria-hidden="true"/g) ?? []).length, 2);
  });

  it("disables Previous on the first page and Next on the last", () => {
    const first = renderToStaticMarkup(<Pagination page={1} totalPages={3} onPageChange={noop} />);
    assert.match(first, /<button type="button"[^>]*disabled=""[^>]*>.*?Previous/);
    assert.doesNotMatch(first, /disabled=""[^>]*><span class="mr-1">Next/);

    const last = renderToStaticMarkup(<Pagination page={3} totalPages={3} onPageChange={noop} />);
    assert.match(last, /disabled=""[^>]*><span class="mr-1">Next/);
  });

  it("uses touch targets of at least 44px", () => {
    const html = renderToStaticMarkup(<Pagination page={2} totalPages={3} onPageChange={noop} />);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    assert.ok(buttons.length > 0);
    for (const button of buttons) assert.match(button, /min-h-11 min-w-11/);
  });

  it("passes an automated accessibility audit", async () => {
    const html = renderToStaticMarkup(<Pagination label="Leaderboard pages" page={4} totalPages={9} onPageChange={noop} />);
    const violations = await auditAccessibility(html);
    assert.equal(violations.length, 0, formatViolations(violations));
  });
});
