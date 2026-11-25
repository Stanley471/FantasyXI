import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import axe from "axe-core";
import {
  aggregateScore,
  applyResults,
  bracketProgress,
  bracketSizeFor,
  buildBracket,
  computeLayout,
  decideWinner,
  liveScoreText,
  predictedPath,
  roundLabel,
  seedOrder,
  simulatePredictions,
  slotState,
} from "../lib/tournamentBracket";
import type { Bracket, BracketEntrant } from "../lib/tournamentBracket";
import { MatchComparison, TournamentBracket } from "../components/leagues/TournamentBracket";

/** Issue #460: interactive tournament bracket and knockout cup tree. */

function entrants(count: number): BracketEntrant[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    name: `Manager ${i + 1}`,
    seed: i + 1,
    squadPoints: 100 - i,
  }));
}

function countOccurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/** Play every open match until the cup is decided (or the guard trips). */
function playAll(bracket: Bracket, winnerSide: "home" | "away", guard = 40): Bracket {
  let current = bracket;
  for (let i = 0; i < guard; i++) {
    const open = current.matches.filter(
      (m) => m.status !== "final" && m.home && m.away
    );
    if (open.length === 0) return current;
    current = applyResults(
      current,
      open.map((m) => ({
        matchId: m.id,
        legs: [winnerSide === "home" ? { home: 60, away: 40 } : { home: 40, away: 60 }],
      }))
    );
  }
  throw new Error("playAll did not finish the bracket");
}

async function auditAccessibility(markup: string): Promise<axe.Result[]> {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title>Bracket</title></head><body><main>${markup}</main></body></html>`,
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

describe("bracket sizing and seeding", () => {
  it("rounds the field up to the next power of two, capped at 128", () => {
    assert.equal(bracketSizeFor(2), 2);
    assert.equal(bracketSizeFor(3), 4);
    assert.equal(bracketSizeFor(16), 16);
    assert.equal(bracketSizeFor(17), 32);
    assert.equal(bracketSizeFor(65), 128);
    assert.equal(bracketSizeFor(128), 128);
  });

  it("rejects fields smaller than 2 or larger than 128", () => {
    assert.throws(() => bracketSizeFor(1), RangeError);
    assert.throws(() => bracketSizeFor(0), RangeError);
    assert.throws(() => bracketSizeFor(129), RangeError);
  });

  it("uses standard seeding order so top seeds meet as late as possible", () => {
    assert.deepEqual(seedOrder(2), [1, 2]);
    assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    assert.deepEqual(seedOrder(16), [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
  });

  it("labels rounds from the size of the round down to the final", () => {
    assert.equal(roundLabel(0, 4), "Round of 16");
    assert.equal(roundLabel(1, 4), "Quarter-Final");
    assert.equal(roundLabel(2, 4), "Semi-Final");
    assert.equal(roundLabel(3, 4), "Final");
    assert.equal(roundLabel(0, 2, "losers"), "Losers Round 1");
    assert.equal(roundLabel(0, 1, "final"), "Grand Final");
  });
});

describe("buildBracket (single elimination)", () => {
  it("builds a 16-manager tree: 15 matches, 4 rounds, seeded round 0", () => {
    const bracket = buildBracket(entrants(16));
    assert.equal(bracket.size, 16);
    assert.equal(bracket.rounds, 4);
    assert.equal(bracket.matches.length, 15);
    assert.equal(bracket.championId, null);
    const round0 = bracket.matches.filter((m) => m.round === 0);
    assert.equal(round0.length, 8);
    // 1v16, 8v9 at the top of the draw.
    assert.equal(round0[0].home?.seed, 1);
    assert.equal(round0[0].away?.seed, 16);
    assert.equal(round0[1].home?.seed, 8);
    assert.equal(round0[1].away?.seed, 9);
    // Later rounds start empty and are labelled.
    const final = bracket.matches.find((m) => m.round === 3);
    assert.equal(final?.label, "Final");
    assert.equal(final?.home, null);
    assert.equal(final?.away, null);
  });

  it("builds 32- and 64-manager trees with the right match counts", () => {
    assert.equal(buildBracket(entrants(32)).matches.length, 31);
    assert.equal(buildBracket(entrants(64)).matches.length, 63);
    assert.equal(buildBracket(entrants(64)).rounds, 6);
    assert.equal(buildBracket(entrants(128)).matches.length, 127);
  });

  it("resolves byes at build time so a 5-manager field plays on", () => {
    const bracket = buildBracket(entrants(5));
    assert.equal(bracket.size, 8);
    assert.equal(bracket.matches.length, 7);
    // Seeds 1, 2 and 3 drew byes and are already through to round 1.
    const round1 = bracket.matches.filter((m) => m.round === 1);
    assert.equal(round1[0].home?.seed, 1);
    assert.equal(round1[0].status, "scheduled");
    assert.equal(round1[1].home?.seed, 2);
    assert.equal(round1[1].away?.seed, 3);
    // The bye matches themselves are decided walkovers with no loser.
    const walkover = bracket.matches.find((m) => m.id === "w0-0");
    assert.equal(walkover?.status, "final");
    assert.equal(walkover?.winnerId, "m1");
    assert.equal(walkover?.loserId, null);
  });

  it("reports progress as decided matches over the total", () => {
    const bracket = buildBracket(entrants(5));
    assert.deepEqual(bracketProgress(bracket), { played: 3, total: 7, percent: 43 });
    assert.deepEqual(bracketProgress(buildBracket(entrants(16))), { played: 0, total: 15, percent: 0 });
  });
});

describe("applyResults and propagation", () => {
  it("feeds round winners into the next round's matchup", () => {
    let bracket = buildBracket(entrants(16));
    bracket = applyResults(bracket, [{ matchId: "w0-0", legs: [{ home: 55, away: 48 }] }]);
    const semi = bracket.matches.find((m) => m.id === "w1-0");
    assert.equal(semi?.home?.id, "m1");
    assert.equal(semi?.away, null);
    assert.equal(bracket.matches.find((m) => m.id === "w0-0")?.winnerId, "m1");
  });

  it("sums legs into an aggregate and lets the away side win on aggregate", () => {
    const bracket = buildBracket(entrants(16));
    const decided = applyResults(bracket, [
      { matchId: "w0-0", legs: [{ home: 30, away: 20 }, { home: 25, away: 40 }] },
    ]);
    const match = decided.matches.find((m) => m.id === "w0-0");
    assert.deepEqual(aggregateScore(match!), { home: 55, away: 60 });
    assert.equal(match?.winnerId, "m16");
    assert.equal(match?.loserId, "m1");
    assert.equal(liveScoreText(match!), "Agg 55–60");
  });

  it("breaks a tied aggregate by the better seed", () => {
    const bracket = buildBracket(entrants(16));
    const decided = applyResults(bracket, [
      { matchId: "w0-0", legs: [{ home: 50, away: 50 }] },
    ]);
    assert.equal(decided.matches.find((m) => m.id === "w0-0")?.winnerId, "m1");
  });

  it("decideWinner returns null without legs or without both entrants", () => {
    const bracket = buildBracket(entrants(16));
    const undecided = bracket.matches.find((m) => m.id === "w0-0")!;
    assert.equal(decideWinner(undecided), null);
    const future = bracket.matches.find((m) => m.id === "w3-0")!;
    assert.equal(decideWinner(future), null);
  });

  it("keeps a live match undecided and does not propagate its winner", () => {
    const bracket = buildBracket(entrants(16));
    const live = applyResults(bracket, [
      { matchId: "w0-0", legs: [{ home: 62, away: 58 }], status: "live" },
    ]);
    const match = live.matches.find((m) => m.id === "w0-0")!;
    assert.equal(match.status, "live");
    assert.equal(match.winnerId, null);
    assert.equal(liveScoreText(match), "62–58");
    assert.equal(live.matches.find((m) => m.id === "w1-0")?.home, null);
    assert.equal(live.championId, null);
  });

  it("ignores results for unknown match ids", () => {
    const bracket = buildBracket(entrants(16));
    const next = applyResults(bracket, [{ matchId: "w9-9", legs: [{ home: 1, away: 0 }] }]);
    assert.equal(next.matches.filter((m) => m.status === "final").length, 0);
  });

  it("crowns the champion once the final is decided", () => {
    const bracket = playAll(buildBracket(entrants(16)), "home");
    assert.equal(bracket.championId, "m1");
    assert.deepEqual(bracketProgress(bracket), { played: 15, total: 15, percent: 100 });
  });

  it("does not mutate the input bracket", () => {
    const bracket = buildBracket(entrants(16));
    applyResults(bracket, [{ matchId: "w0-0", legs: [{ home: 55, away: 48 }] }]);
    assert.equal(bracket.matches.find((m) => m.id === "w0-0")?.status, "scheduled");
    assert.equal(bracket.matches.find((m) => m.id === "w1-0")?.home, null);
  });
});

describe("buildBracket (double elimination)", () => {
  it("builds an 8-manager double-elim tree: 7 winners, 6 losers, 1 grand final", () => {
    const bracket = buildBracket(entrants(8), { format: "double" });
    assert.equal(bracket.matches.length, 14);
    assert.equal(bracket.matches.filter((m) => m.side === "winners").length, 7);
    assert.equal(bracket.matches.filter((m) => m.side === "losers").length, 6);
    assert.equal(bracket.matches.filter((m) => m.side === "final").length, 1);
    assert.equal(bracket.matches.filter((m) => m.side === "losers").map((m) => m.round).sort().join(","), "0,0,1,1,2,3");
  });

  it("routes round-0 losers into the first losers round", () => {
    const bracket = buildBracket(entrants(8), { format: "double" });
    const first = applyResults(bracket, [{ matchId: "w0-0", legs: [{ home: 60, away: 40 }] }]);
    // m8 lost w0-0 and drops into losers round 0 as home.
    assert.equal(first.matches.find((m) => m.id === "l0-0")?.home?.id, "m8");
    // m1 won w0-0 and moves on in the winners bracket.
    assert.equal(first.matches.find((m) => m.id === "w1-0")?.home?.id, "m1");
  });

  it("routes the winners-final loser into the last losers round", () => {
    let bracket = buildBracket(entrants(8), { format: "double" });
    // Home wins every winners match: w2-0 is m1 vs m2, m2 loses the final.
    for (const round of [0, 1, 2]) {
      const open = bracket.matches.filter(
        (m) => m.side === "winners" && m.round === round && m.home && m.away && m.status !== "final"
      );
      bracket = applyResults(bracket, open.map((m) => ({ matchId: m.id, legs: [{ home: 60, away: 40 }] })));
    }
    assert.equal(bracket.matches.find((m) => m.id === "w2-0")?.winnerId, "m1");
    // m2 has one loss and is still alive in the losers bracket's last round.
    const lastLosers = bracket.matches.find((m) => m.id === "l3-0")!;
    assert.equal(lastLosers.away?.id, "m2");
    assert.equal(slotState(bracket.matches, lastLosers, "away"), "filled");
  });

  it("ends the cup when the winners champion wins the grand final", () => {
    const bracket = playAll(buildBracket(entrants(8), { format: "double" }), "home");
    assert.equal(bracket.championId, "m1");
    assert.equal(bracket.matches.filter((m) => m.side === "final").length, 1);
  });

  it("creates a bracket reset when the losers champion wins the grand final", () => {
    // Away wins everything: the losers-bracket survivor takes the grand final.
    const bracket = playAll(buildBracket(entrants(8), { format: "double" }), "away");
    assert.equal(bracket.matches.filter((m) => m.side === "final").length, 2);
    const grandFinal = bracket.matches.find((m) => m.id === "f0-0")!;
    const reset = bracket.matches.find((m) => m.id === "f1-0")!;
    assert.equal(grandFinal.status, "final");
    assert.equal(reset.status, "final");
    assert.equal(reset.home?.id, grandFinal.winnerId);
    assert.equal(reset.away?.id, grandFinal.loserId);
    // Away also won the reset, so the winners-bracket champion takes the
    // title back: the grand-final winner lost the second final.
    assert.equal(bracket.championId, reset.winnerId);
    assert.equal(reset.winnerId, "m6");
    assert.equal(reset.home?.id, grandFinal.winnerId);
    assert.equal(reset.away?.id, grandFinal.loserId);
  });

  it("leaves the title undecided while the reset is still to be played", () => {
    let bracket = buildBracket(entrants(8), { format: "double" });
    // Play everything with away winning, but stop before the reset.
    for (let i = 0; i < 10; i++) {
      const open = bracket.matches.filter(
        (m) => m.status !== "final" && m.home && m.away && m.id !== "f1-0"
      );
      if (open.length === 0) break;
      bracket = applyResults(bracket, open.map((m) => ({ matchId: m.id, legs: [{ home: 40, away: 60 }] })));
    }
    assert.equal(bracket.matches.some((m) => m.id === "f1-0"), true);
    assert.equal(bracket.matches.find((m) => m.id === "f1-0")?.status, "scheduled");
    assert.equal(bracket.championId, null);
  });
});

describe("computeLayout", () => {
  it("lays out a 16-manager tree with centred rounds and bezier connectors", () => {
    const layout = computeLayout(buildBracket(entrants(16)));
    assert.equal(layout.matches.length, 15);
    assert.equal(layout.connectors.length, 14);
    assert.equal(layout.width, 1024);
    assert.equal(layout.height, 736);
    // Golden snapshot: match id -> x, y (default 220x76 nodes, 48px gaps).
    assert.deepEqual(
      layout.matches.map((m) => [m.match.id, m.x, m.y]),
      [
        ["w0-0", 0, 8], ["w0-1", 0, 100], ["w0-2", 0, 192], ["w0-3", 0, 284],
        ["w0-4", 0, 376], ["w0-5", 0, 468], ["w0-6", 0, 560], ["w0-7", 0, 652],
        ["w1-0", 268, 54], ["w1-1", 268, 238], ["w1-2", 268, 422], ["w1-3", 268, 606],
        ["w2-0", 536, 146], ["w2-1", 536, 514], ["w3-0", 804, 330],
      ]
    );
    // Every connector runs left-to-right inside the canvas.
    for (const connector of layout.connectors) {
      assert.match(connector.d, /^M \d+ \d+ C [\d.]+ \d+, [\d.]+ \d+, \d+ \d+$/);
    }
    // No two matches in the same round overlap vertically.
    for (let round = 0; round < 4; round++) {
      const rows = layout.matches
        .filter((m) => m.match.round === round && m.match.side === "winners")
        .map((m) => m.y)
        .sort((a, b) => a - b);
      rows.forEach((y, i) => {
        if (i > 0) assert.ok(y - rows[i - 1] >= 76, `round ${round} overlaps`);
      });
    }
  });

  it("scales node and connector counts to 32, 64 and 128 managers", () => {
    for (const [size, nodes, connectors] of [[32, 31, 30], [64, 63, 62], [128, 127, 126]] as const) {
      const layout = computeLayout(buildBracket(entrants(size)));
      assert.equal(layout.matches.length, nodes, `${size} managers`);
      assert.equal(layout.connectors.length, connectors, `${size} managers`);
      for (const m of layout.matches) {
        assert.ok(m.x >= 0 && m.x + m.width <= layout.width);
        assert.ok(m.y >= 0 && m.y + m.height <= layout.height);
      }
    }
  });

  it("marks connectors decided once their feeder match is final", () => {
    const bracket = applyResults(buildBracket(entrants(16)), [
      { matchId: "w0-0", legs: [{ home: 55, away: 48 }] },
    ]);
    const layout = computeLayout(bracket);
    const decided = layout.connectors.filter((c) => c.fromMatchId === "w0-0");
    assert.equal(decided.length, 1);
    assert.equal(decided[0].decided, true);
    assert.equal(decided[0].toMatchId, "w1-0");
    const undecided = layout.connectors.filter((c) => c.fromMatchId === "w0-1");
    assert.equal(undecided[0].decided, false);
  });

  it("lays out the double-elimination tree below the winners bracket", () => {
    const layout = computeLayout(buildBracket(entrants(8), { format: "double" }));
    assert.equal(layout.matches.length, 14);
    assert.equal(layout.connectors.length, 20);
    const losers = layout.matches.filter((m) => m.match.side === "losers");
    const winners = layout.matches.filter((m) => m.match.side === "winners");
    assert.ok(Math.min(...losers.map((m) => m.y)) > Math.max(...winners.map((m) => m.y)));
    const grandFinal = layout.matches.find((m) => m.match.id === "f0-0")!;
    assert.ok(grandFinal.x > Math.max(...winners.map((m) => m.x)));
  });
});

describe("simulatePredictions", () => {
  it("fills future rounds from picks and names the predicted champion", () => {
    const bracket = buildBracket(entrants(16));
    const { matches, predictedChampionId } = simulatePredictions(bracket, {
      "w0-0": "m1",
      "w0-1": "m8",
      "w1-0": "m1",
      "w2-0": "m1",
      "w3-0": "m1",
    });
    assert.equal(predictedChampionId, "m1");
    const semi = matches.find((m) => m.id === "w1-0")!;
    assert.equal(semi.home?.id, "m1");
    assert.equal(semi.away?.id, "m8");
    assert.equal(semi.predictedWinnerId, "m1");
    // Real results are untouched by a simulation.
    assert.equal(bracket.matches.find((m) => m.id === "w1-0")?.home, null);
    assert.equal(bracket.championId, null);
  });

  it("ignores picks for entrants who are not in the match", () => {
    const bracket = buildBracket(entrants(16));
    const { matches, predictedChampionId } = simulatePredictions(bracket, {
      "w0-0": "m5",
      "w9-9": "m1",
    });
    assert.equal(predictedChampionId, null);
    assert.equal(matches.find((m) => m.id === "w0-0")?.predictedWinnerId, undefined);
    assert.equal(matches.find((m) => m.id === "w1-0")?.home, null);
  });

  it("never overrides a real entrant with a prediction", () => {
    let bracket = buildBracket(entrants(16));
    bracket = applyResults(bracket, [{ matchId: "w0-0", legs: [{ home: 55, away: 48 }] }]);
    const { matches } = simulatePredictions(bracket, { "w1-0": "m1" });
    // m1 really won w0-0, so w1-0 home is m1 either way; the pick is valid.
    assert.equal(matches.find((m) => m.id === "w1-0")?.home?.id, "m1");
    assert.equal(matches.find((m) => m.id === "w1-0")?.predictedWinnerId, "m1");
  });

  it("traces an entrant's predicted path through the bracket", () => {
    const bracket = buildBracket(entrants(16));
    const path = predictedPath(bracket, { "w0-0": "m1", "w1-0": "m1", "w2-0": "m1", "w3-0": "m1" }, "m1");
    assert.deepEqual(path.map((m) => m.id), ["w0-0", "w1-0", "w2-0", "w3-0"]);
    assert.deepEqual(predictedPath(bracket, {}, "m1").map((m) => m.id), ["w0-0"]);
  });
});

describe("TournamentBracket component", () => {
  it("renders 15 match nodes and 14 connectors for 16 managers", () => {
    const markup = renderToStaticMarkup(<TournamentBracket teams={entrants(16)} />);
    assert.equal(countOccurrences(markup, 'data-testid="bracket-match"'), 15);
    assert.equal(countOccurrences(markup, 'data-testid="bracket-connector"'), 14);
    assert.match(markup, /Round of 16/);
    assert.match(markup, /Quarter-Final/);
    assert.match(markup, /Semi-Final/);
    assert.match(markup, />Final</);
    assert.match(markup, /Manager 1/);
    assert.match(markup, /data-testid="bracket-viewport"/);
    assert.doesNotMatch(markup, /Champion:/);
  });

  it("renders 31 and 63 match nodes for 32 and 64 managers", () => {
    assert.equal(
      countOccurrences(renderToStaticMarkup(<TournamentBracket teams={entrants(32)} />), 'data-testid="bracket-match"'),
      31
    );
    assert.equal(
      countOccurrences(renderToStaticMarkup(<TournamentBracket teams={entrants(64)} />), 'data-testid="bracket-match"'),
      63
    );
  });

  it("shows the empty state when no teams are registered", () => {
    const markup = renderToStaticMarkup(<TournamentBracket teams={[]} />);
    assert.match(markup, /No teams registered for this bracket yet/);
    assert.equal(countOccurrences(markup, 'data-testid="bracket-match"'), 0);
  });

  it("marks live matches with a pulsing indicator and live score", () => {
    const markup = renderToStaticMarkup(
      <TournamentBracket
        teams={entrants(16)}
        results={[{ matchId: "w0-0", legs: [{ home: 62, away: 58 }], status: "live" }]}
      />
    );
    assert.equal(countOccurrences(markup, 'data-testid="live-indicator"'), 1);
    assert.match(markup, /1 live/);
    assert.match(markup, /62/);
    assert.match(markup, /58/);
    assert.match(markup, /data-status="live"/);
  });

  it("shows the champion banner once the cup is decided", () => {
    const bracket = playAll(buildBracket(entrants(16)), "home");
    const results = bracket.matches
      .filter((m) => m.status === "final")
      .map((m) => ({ matchId: m.id, legs: m.legs }));
    const markup = renderToStaticMarkup(<TournamentBracket teams={entrants(16)} results={results} />);
    assert.match(markup, /Champion:/);
    assert.match(markup, /Manager 1/);
    assert.match(markup, /15\/15 matches decided/);
  });

  it("shows aggregate leg scores on two-legged ties", () => {
    const markup = renderToStaticMarkup(
      <TournamentBracket
        teams={entrants(16)}
        results={[{ matchId: "w0-0", legs: [{ home: 30, away: 20 }, { home: 25, away: 40 }] }]}
      />
    );
    assert.match(markup, /Agg 55–60/);
    assert.match(markup, /FT/);
  });

  it("renders the losers bracket and grand final for double elimination", () => {
    const markup = renderToStaticMarkup(<TournamentBracket teams={entrants(8)} format="double" />);
    assert.equal(countOccurrences(markup, 'data-testid="bracket-match"'), 14);
    assert.match(markup, /Losers Round 1/);
    assert.match(markup, /Grand Final/);
    assert.match(markup, /Double elimination/);
  });

  it("shows the predicted champion in prediction mode", () => {
    const markup = renderToStaticMarkup(
      <TournamentBracket
        teams={entrants(16)}
        predictionMode
        initialPredictions={{ "w0-0": "m1", "w0-1": "m8", "w1-0": "m1", "w2-0": "m1", "w3-0": "m1" }}
      />
    );
    assert.match(markup, /Predicted champion:/);
    assert.match(markup, /Manager 1/);
    assert.match(markup, /\(predicted\)/);
    assert.match(markup, /Prediction mode: on/);
  });

  it("offers pick buttons for future ties in prediction mode", () => {
    const markup = renderToStaticMarkup(
      <TournamentBracket teams={entrants(16)} predictionMode />
    );
    assert.match(markup, /Predict Manager 1 to win Round of 16/);
    assert.match(markup, /Predict Manager 16 to win Round of 16/);
  });

  it("has no accessibility violations on a 16-manager bracket", async () => {
    const markup = renderToStaticMarkup(<TournamentBracket teams={entrants(16)} />);
    const violations = await auditAccessibility(markup);
    assert.equal(
      violations.length,
      0,
      violations.map((v) => `${v.id}: ${v.help}`).join("\n")
    );
  });
});

describe("MatchComparison", () => {
  it("renders both squads side by side with totals and leg scores", () => {
    const bracket = applyResults(buildBracket(entrants(16)), [
      { matchId: "w0-0", legs: [{ home: 30, away: 20 }, { home: 25, away: 40 }] },
    ]);
    const match = bracket.matches.find((m) => m.id === "w0-0")!;
    const squads = {
      m1: [
        { name: "Alisson", position: "GKP", points: 6 },
        { name: "Salah", position: "MID", points: 12 },
      ],
      m16: [
        { name: "Raya", position: "GKP", points: 2 },
        { name: "Palmer", position: "MID", points: 9 },
      ],
    };
    const markup = renderToStaticMarkup(<MatchComparison match={match} squads={squads} />);
    assert.match(markup, /Manager 1/);
    assert.match(markup, /Manager 16/);
    assert.match(markup, /Salah/);
    assert.match(markup, /Palmer/);
    assert.match(markup, /18 pts/);
    assert.match(markup, /11 pts/);
    assert.match(markup, /Leg 1: 30–20/);
    assert.match(markup, /Leg 2: 25–40/);
    assert.match(markup, /Final: Agg 55–60/);
    assert.match(markup, /Winner/);
    assert.match(markup, /data-testid="comparison-home"/);
    assert.match(markup, /data-testid="comparison-away"/);
  });

  it("says so when a manager has no squad data", () => {
    const match = buildBracket(entrants(16)).matches.find((m) => m.id === "w0-0")!;
    const markup = renderToStaticMarkup(<MatchComparison match={match} squads={{}} />);
    assert.equal(countOccurrences(markup, "No squad data for this manager yet"), 2);
  });
});
