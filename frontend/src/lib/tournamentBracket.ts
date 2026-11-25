/**
 * Pure tournament-bracket logic for the knockout cup tree (issue #460).
 *
 * Everything in this module is a pure function of its inputs: bracket
 * construction, seeding, result application, winner/loser propagation,
 * SVG layout math and prediction simulation. No React, no DOM, no I/O, so
 * it is unit-testable in isolation and reusable by any renderer.
 *
 * Model
 * -----
 * - A bracket holds up to 128 entrants (a power-of-two tree; byes pad the
 *   field). `format: "single"` is a straight knockout; `"double"` adds a
 *   losers bracket and a grand final with a bracket reset.
 * - Every match slot is fed by either nothing (round 0, seeded directly),
 *   the winner of another match, or the loser of another match. Slots are
 *   "tbd" while their feeder is undecided, "bye" once their feeder is
 *   decided and produced nobody, and filled once an entrant lands there.
 * - A match with one filled slot and one bye slot is decided by walkover:
 *   the present entrant advances and there is no loser to route onwards.
 * - Results are per-leg scores. The aggregate decides the winner; a tied
 *   aggregate is broken by the better (lower) seed, then by the home slot,
 *   so a result is always deterministic.
 */

export interface BracketEntrant {
  id: string;
  name: string;
  seed?: number;
  /** Fantasy points the manager's squad has scored so far (H2H preview). */
  squadPoints?: number;
}

export type BracketFormat = "single" | "double";
export type BracketMatchStatus = "scheduled" | "live" | "final";
export type BracketSlot = "home" | "away";
export type BracketSide = "winners" | "losers" | "final";

export interface BracketLegScore {
  home: number;
  away: number;
}

export interface BracketFeeder {
  matchId: string;
  /** Which side of the feeder match feeds this slot. */
  kind: "winner" | "loser";
}

export interface BracketMatch {
  id: string;
  side: BracketSide;
  /** 0-based round index within its side. */
  round: number;
  position: number;
  label: string;
  home: BracketEntrant | null;
  away: BracketEntrant | null;
  homeFeeder: BracketFeeder | null;
  awayFeeder: BracketFeeder | null;
  legs: BracketLegScore[];
  status: BracketMatchStatus;
  winnerId: string | null;
  loserId: string | null;
  nextMatchId: string | null;
  nextSlot: BracketSlot | null;
  loserNextMatchId: string | null;
  loserNextSlot: BracketSlot | null;
  /** Prediction-mode pick for this match; never set by real results. */
  predictedWinnerId?: string | null;
}

export interface Bracket {
  format: BracketFormat;
  /** Power-of-two bracket size (entrants padded with byes). */
  size: number;
  /** Number of winners-bracket rounds. */
  rounds: number;
  matches: BracketMatch[];
  championId: string | null;
}

export interface BracketResultInput {
  matchId: string;
  legs: BracketLegScore[];
  status?: BracketMatchStatus;
}

export const MAX_BRACKET_SIZE = 128;
export const MIN_BRACKET_SIZE = 2;

/** Next power of two >= count, clamped to the 2..128 bracket limits. */
export function bracketSizeFor(entrantCount: number): number {
  if (!Number.isInteger(entrantCount) || entrantCount < MIN_BRACKET_SIZE) {
    throw new RangeError(`A bracket needs at least ${MIN_BRACKET_SIZE} entrants, got ${entrantCount}`);
  }
  if (entrantCount > MAX_BRACKET_SIZE) {
    throw new RangeError(`A bracket supports at most ${MAX_BRACKET_SIZE} entrants, got ${entrantCount}`);
  }
  let size = MIN_BRACKET_SIZE;
  while (size < entrantCount) size *= 2;
  return size;
}

/**
 * Standard tournament seeding order: position i of the returned array is
 * the seed placed in slot i of round 0. Top seeds are kept apart until the
 * latest possible round: 4 -> [1,4,2,3], 8 -> [1,8,4,5,2,7,3,6].
 */
export function seedOrder(size: number): number[] {
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new RangeError(`seedOrder needs a power-of-two size >= 2, got ${size}`);
  }
  let order = [1, 2];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((seed) => [seed, next + 1 - seed]);
  }
  return order;
}

export function roundLabel(round: number, totalRounds: number, side: BracketSide = "winners"): string {
  if (side === "final") return "Grand Final";
  if (side === "losers") return `Losers Round ${round + 1}`;
  const remaining = totalRounds - round;
  if (remaining === 1) return "Final";
  if (remaining === 2) return "Semi-Final";
  if (remaining === 3) return "Quarter-Final";
  return `Round of ${Math.pow(2, remaining)}`;
}

/** Aggregate (summed leg) score of a match. */
export function aggregateScore(match: Pick<BracketMatch, "legs">): { home: number; away: number } {
  return match.legs.reduce(
    (total, leg) => ({ home: total.home + leg.home, away: total.away + leg.away }),
    { home: 0, away: 0 }
  );
}

function entrantById(matches: BracketMatch[], id: string | null): BracketEntrant | null {
  if (id === null) return null;
  for (const match of matches) {
    if (match.home?.id === id) return match.home;
    if (match.away?.id === id) return match.away;
  }
  return null;
}

/**
 * Winner of a decided match from its legs. Null while the match has no
 * legs (or only live, unscored legs). Ties go to the better seed, then home.
 */
export function decideWinner(match: BracketMatch): BracketEntrant | null {
  if (!match.home || !match.away || match.legs.length === 0) return null;
  const { home, away } = aggregateScore(match);
  if (home === away) {
    const homeSeed = match.home.seed ?? Number.POSITIVE_INFINITY;
    const awaySeed = match.away.seed ?? Number.POSITIVE_INFINITY;
    return awaySeed < homeSeed ? match.away : match.home;
  }
  return home > away ? match.home : match.away;
}

export type SlotState = "filled" | "tbd" | "bye";

/** Why a slot is empty: its feeder is still undecided ("tbd") or produced nobody ("bye"). */
export function slotState(
  matches: BracketMatch[],
  match: BracketMatch,
  slot: BracketSlot
): SlotState {
  if (match[slot]) return "filled";
  const feeder = slot === "home" ? match.homeFeeder : match.awayFeeder;
  if (!feeder) return "bye";
  const feederMatch = matches.find((m) => m.id === feeder.matchId);
  if (!feederMatch || feederMatch.status !== "final") return "tbd";
  if (feeder.kind === "winner") return feederMatch.winnerId ? "filled" : "bye";
  return feederMatch.loserId ? "filled" : "bye";
}

function cloneMatches(matches: BracketMatch[]): BracketMatch[] {
  return matches.map((m) => ({ ...m, legs: m.legs.map((leg) => ({ ...leg })) }));
}

/**
 * Fixpoint propagation: feed decided winners/losers into their next match,
 * then resolve walkovers (one filled slot + one bye slot advances the
 * present entrant; two bye slots decide the match with no winner).
 * Returns fresh match objects; the input array is not mutated.
 */
export function propagateResults(matches: BracketMatch[]): BracketMatch[] {
  const next = cloneMatches(matches);
  const byId = new Map(next.map((m) => [m.id, m]));
  let changed = true;
  let guard = 0;
  while (changed && guard < 100) {
    changed = false;
    guard += 1;
    for (const match of next) {
      if (match.status !== "final") continue;
      const winner = entrantById(next, match.winnerId);
      const loser = entrantById(next, match.loserId);
      if (match.nextMatchId) {
        const target = byId.get(match.nextMatchId);
        if (target && winner && target[match.nextSlot ?? "home"]?.id !== winner.id) {
          target[match.nextSlot ?? "home"] = winner;
          changed = true;
        }
      }
      if (match.loserNextMatchId) {
        const target = byId.get(match.loserNextMatchId);
        if (target && loser && target[match.loserNextSlot ?? "home"]?.id !== loser.id) {
          target[match.loserNextSlot ?? "home"] = loser;
          changed = true;
        }
      }
    }
    // Walkovers: a match whose one slot is a bye and the other is filled.
    for (const match of next) {
      if (match.status === "final") continue;
      const homeState = slotState(next, match, "home");
      const awayState = slotState(next, match, "away");
      if (homeState === "filled" && awayState === "bye" && match.home) {
        match.status = "final";
        match.winnerId = match.home.id;
        match.loserId = null;
        changed = true;
      } else if (awayState === "filled" && homeState === "bye" && match.away) {
        match.status = "final";
        match.winnerId = match.away.id;
        match.loserId = null;
        changed = true;
      } else if (homeState === "bye" && awayState === "bye") {
        match.status = "final";
        match.winnerId = null;
        match.loserId = null;
        changed = true;
      }
    }
  }
  return next;
}

function computeChampion(matches: BracketMatch[], format: BracketFormat): string | null {
  const finals = matches.filter((m) => m.side === "final").sort((a, b) => a.round - b.round);
  if (finals.length === 0) {
    const winnersFinal = matches
      .filter((m) => m.side === "winners")
      .sort((a, b) => b.round - a.round || b.position - a.position)[0];
    return winnersFinal?.winnerId ?? null;
  }
  const reset = finals[1];
  if (reset && reset.status === "final") return reset.winnerId;
  const grandFinal = finals[0];
  if (grandFinal.status !== "final" || !grandFinal.winnerId) return null;
  if (format === "single") return grandFinal.winnerId;
  // Double elimination: if the losers-bracket champion took the grand
  // final, the title is decided by the reset match, which is still pending.
  const losersChampionId = matches
    .filter((m) => m.side === "losers")
    .sort((a, b) => b.round - a.round)[0]?.winnerId;
  if (losersChampionId && grandFinal.winnerId === losersChampionId) return null;
  return grandFinal.winnerId;
}

interface BuildOptions {
  format?: BracketFormat;
}

function sortEntrants(entrants: BracketEntrant[]): BracketEntrant[] {
  return [...entrants].sort((a, b) => {
    const seedA = a.seed ?? Number.POSITIVE_INFINITY;
    const seedB = b.seed ?? Number.POSITIVE_INFINITY;
    return seedA - seedB;
  });
}

function makeMatch(
  side: BracketSide,
  round: number,
  position: number,
  label: string,
  home: BracketEntrant | null = null,
  away: BracketEntrant | null = null
): BracketMatch {
  const prefix = side === "winners" ? "w" : side === "losers" ? "l" : "f";
  return {
    id: `${prefix}${round}-${position}`,
    side,
    round,
    position,
    label,
    home,
    away,
    homeFeeder: null,
    awayFeeder: null,
    legs: [],
    status: "scheduled",
    winnerId: null,
    loserId: null,
    nextMatchId: null,
    nextSlot: null,
    loserNextMatchId: null,
    loserNextSlot: null,
  };
}

/**
 * Build a full bracket tree from entrants. Round 0 is seeded by standard
 * seeding order; later rounds start empty and fill in as results land.
 * Byes (a field that is not a power of two) resolve immediately: entrants
 * drawn against a bye advance without playing.
 */
export function buildBracket(entrants: BracketEntrant[], options: BuildOptions = {}): Bracket {
  const format = options.format ?? "single";
  const size = bracketSizeFor(entrants.length);
  const rounds = Math.log2(size);
  const seeded = sortEntrants(entrants);
  const order = seedOrder(size);
  const bySeed = new Map<number, BracketEntrant>();
  seeded.forEach((entrant, index) => {
    bySeed.set(entrant.seed ?? index + 1, entrant);
  });
  // Entrants without an explicit seed take the next free seed numbers.
  const placed: Array<BracketEntrant | null> = order.map((seed) => bySeed.get(seed) ?? null);

  const matches: BracketMatch[] = [];

  // Winners bracket: every round, every match, wired to the next round.
  for (let round = 0; round < rounds; round++) {
    const count = size / Math.pow(2, round + 1);
    for (let position = 0; position < count; position++) {
      const match = makeMatch("winners", round, position, roundLabel(round, rounds, "winners"));
      if (round === 0) {
        match.home = placed[position * 2];
        match.away = placed[position * 2 + 1];
      } else {
        const feederA = matches.find((m) => m.side === "winners" && m.round === round - 1 && m.position === position * 2);
        const feederB = matches.find((m) => m.side === "winners" && m.round === round - 1 && m.position === position * 2 + 1);
        if (feederA) match.homeFeeder = { matchId: feederA.id, kind: "winner" };
        if (feederB) match.awayFeeder = { matchId: feederB.id, kind: "winner" };
      }
      if (round < rounds - 1) {
        match.nextMatchId = `w${round + 1}-${Math.floor(position / 2)}`;
        match.nextSlot = position % 2 === 0 ? "home" : "away";
      }
      matches.push(match);
    }
  }

  if (format === "double") {
    buildLosersBracket(matches, size, rounds);
  }

  // Grand final (double elimination only): winners-bracket champion vs
  // losers-bracket champion, plus a reset match if the losers side wins.
  if (format === "double") {
    const winnersFinal = matches.find((m) => m.side === "winners" && m.round === rounds - 1);
    const losersFinal = matches
      .filter((m) => m.side === "losers")
      .sort((a, b) => b.round - a.round)[0];
    const grandFinal = makeMatch("final", 0, 0, "Grand Final");
    if (winnersFinal) {
      grandFinal.homeFeeder = { matchId: winnersFinal.id, kind: "winner" };
      winnersFinal.nextMatchId = grandFinal.id;
      winnersFinal.nextSlot = "home";
    }
    if (losersFinal) {
      grandFinal.awayFeeder = { matchId: losersFinal.id, kind: "winner" };
      losersFinal.nextMatchId = grandFinal.id;
      losersFinal.nextSlot = "away";
    }
    matches.push(grandFinal);
    // No reset match yet: it is created by applyResults only if the
    // losers-bracket champion wins the grand final (see activateReset).
  }

  const resolved = propagateResults(matches);
  return { format, size, rounds, matches: resolved, championId: computeChampion(resolved, format) };
}

/**
 * Losers bracket for double elimination. Rounds alternate between
 * "losers of the next winners round drop in" and "losers-bracket winners
 * play each other", so the bracket narrows from size/4 matches to one.
 * Losers-bracket rounds: 2 * rounds - 2.
 */
function buildLosersBracket(matches: BracketMatch[], size: number, rounds: number): void {
  const losersRounds = 2 * rounds - 2;
  // losersRound -> { winnersRoundFeedingLosers, count }
  for (let lr = 0; lr < losersRounds; lr++) {
    const count = size / Math.pow(2, Math.floor(lr / 2) + 2);
    for (let position = 0; position < count; position++) {
      const match = makeMatch("losers", lr, position, roundLabel(lr, losersRounds, "losers"));
      if (lr === 0) {
        // Losers of winners round 0, paired in order.
        const feederA = matches.find((m) => m.side === "winners" && m.round === 0 && m.position === position * 2);
        const feederB = matches.find((m) => m.side === "winners" && m.round === 0 && m.position === position * 2 + 1);
        if (feederA) match.homeFeeder = { matchId: feederA.id, kind: "loser" };
        if (feederB) match.awayFeeder = { matchId: feederB.id, kind: "loser" };
      } else if (lr % 2 === 1) {
        // Odd losers round: previous losers winners vs losers of the next
        // winners round (winners round lr/2 rounded up).
        const winnersRound = Math.floor(lr / 2) + 1;
        const prevLosers = matches.find((m) => m.side === "losers" && m.round === lr - 1 && m.position === position);
        const winnersFeeder = matches.find(
          (m) => m.side === "winners" && m.round === winnersRound && m.position === position
        );
        if (prevLosers) match.homeFeeder = { matchId: prevLosers.id, kind: "winner" };
        if (winnersFeeder) match.awayFeeder = { matchId: winnersFeeder.id, kind: "loser" };
      } else {
        // Even losers round: previous losers winners play each other.
        const feederA = matches.find((m) => m.side === "losers" && m.round === lr - 1 && m.position === position * 2);
        const feederB = matches.find((m) => m.side === "losers" && m.round === lr - 1 && m.position === position * 2 + 1);
        if (feederA) match.homeFeeder = { matchId: feederA.id, kind: "winner" };
        if (feederB) match.awayFeeder = { matchId: feederB.id, kind: "winner" };
      }
      if (lr < losersRounds - 1) {
        if (lr % 2 === 0) {
          // Even -> odd round: same match count, winners feed straight in.
          match.nextMatchId = `l${lr + 1}-${position}`;
          match.nextSlot = "home";
        } else {
          // Odd -> even round: the count halves, pairs feed one match.
          match.nextMatchId = `l${lr + 1}-${Math.floor(position / 2)}`;
          match.nextSlot = position % 2 === 0 ? "home" : "away";
        }
      }
      matches.push(match);
    }
  }

  // Route every winners-bracket loser's onward match. Round 0 losers pair
  // into losers round 0; losers of winners round r (r >= 1) drop into
  // losers round 2r-1 — including the winners-final loser, who meets the
  // losers bracket's survivor in the last losers round.
  for (const match of matches) {
    if (match.side !== "winners") continue;
    if (match.round === 0) {
      match.loserNextMatchId = `l0-${Math.floor(match.position / 2)}`;
      match.loserNextSlot = match.position % 2 === 0 ? "home" : "away";
    } else {
      match.loserNextMatchId = `l${2 * match.round - 1}-${match.position}`;
      match.loserNextSlot = "away";
    }
  }
}

/** Progress of a bracket: how many matches are decided out of the total. */
export function bracketProgress(bracket: Bracket): { played: number; total: number; percent: number } {
  const total = bracket.matches.length;
  const played = bracket.matches.filter((m) => m.status === "final").length;
  return { played, total, percent: total === 0 ? 0 : Math.round((played / total) * 100) };
}

/**
 * Apply results to a bracket (immutable: returns a new Bracket). A "live"
 * result updates the score without deciding the match; a "final" result
 * decides it and propagates the winner (and, in double elimination, the
 * loser) into the next round. Results are applied in bracket order — a
 * feeder match before the matches it feeds — with propagation after each
 * one, so a whole cup's results can be applied in a single call. Unknown
 * match ids are ignored.
 */
export function applyResults(bracket: Bracket, results: BracketResultInput[]): Bracket {
  let matches = cloneMatches(bracket.matches);
  const sideRank = (side: BracketSide) => (side === "winners" ? 0 : side === "losers" ? 1 : 2);
  const rankOf = (match: BracketMatch) => sideRank(match.side) * 10000 + match.round * 100 + match.position;
  const sorted = [...results].sort((a, b) => {
    const matchA = matches.find((m) => m.id === a.matchId);
    const matchB = matches.find((m) => m.id === b.matchId);
    return (matchA ? rankOf(matchA) : Number.POSITIVE_INFINITY) - (matchB ? rankOf(matchB) : Number.POSITIVE_INFINITY);
  });
  for (const result of sorted) {
    const match = matches.find((m) => m.id === result.matchId);
    if (!match) continue;
    match.legs = result.legs.map((leg) => ({ ...leg }));
    match.status = result.status ?? "final";
    if (match.status === "final") {
      const winner = decideWinner(match);
      match.winnerId = winner?.id ?? null;
      match.loserId =
        winner && match.home && match.away
          ? (winner.id === match.home.id ? match.away : match.home).id
          : null;
    } else {
      match.winnerId = null;
      match.loserId = null;
    }
    matches = propagateResults(matches);
    matches = activateReset(matches, bracket.format);
  }
  return { ...bracket, matches, championId: computeChampion(matches, bracket.format) };
}

/**
 * Double elimination: when the losers-bracket champion wins the grand
 * final, the winners-bracket champion earns a second final (bracket
 * reset). The reset match only comes into existence then — a grand final
 * won by the winners side ends the cup outright.
 */
function activateReset(matches: BracketMatch[], format: BracketFormat): BracketMatch[] {
  if (format !== "double") return matches;
  if (matches.some((m) => m.side === "final" && m.round === 1)) return matches;
  const grandFinal = matches.find((m) => m.side === "final" && m.round === 0);
  if (!grandFinal || grandFinal.status !== "final" || !grandFinal.winnerId) return matches;
  const losersChampionId = matches
    .filter((m) => m.side === "losers")
    .sort((a, b) => b.round - a.round)[0]?.winnerId;
  if (!losersChampionId || grandFinal.winnerId !== losersChampionId) return matches;
  const reset = makeMatch("final", 1, 0, "Grand Final (Reset)");
  reset.homeFeeder = { matchId: grandFinal.id, kind: "winner" };
  reset.awayFeeder = { matchId: grandFinal.id, kind: "loser" };
  const withReset = [...matches, reset];
  // Feed the reset from the grand final: winner defends the title as home,
  // the grand-final loser gets a second shot as away.
  const gf = withReset.find((m) => m.id === grandFinal.id);
  if (gf) {
    gf.nextMatchId = reset.id;
    gf.nextSlot = "home";
    gf.loserNextMatchId = reset.id;
    gf.loserNextSlot = "away";
  }
  return propagateResults(withReset);
}

/** Live H2H preview text for a match, e.g. "62–58" or "1st leg 34–30". */
export function liveScoreText(match: BracketMatch): string | null {
  if (match.legs.length === 0) return null;
  const { home, away } = aggregateScore(match);
  if (match.legs.length === 1) return `${home}–${away}`;
  return `Agg ${home}–${away}`;
}

// ============================================================
// Layout (pure SVG geometry)
// ============================================================

export interface BracketLayoutOptions {
  matchWidth?: number;
  matchHeight?: number;
  roundGap?: number;
  matchGap?: number;
}

export interface PositionedMatch {
  match: BracketMatch;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BracketConnector {
  id: string;
  fromMatchId: string;
  toMatchId: string;
  /** Cubic bezier path from the feeder match to the fed match. */
  d: string;
  decided: boolean;
}

export interface BracketLayout {
  matches: PositionedMatch[];
  connectors: BracketConnector[];
  width: number;
  height: number;
}

const DEFAULT_LAYOUT: Required<BracketLayoutOptions> = {
  matchWidth: 220,
  matchHeight: 76,
  roundGap: 48,
  matchGap: 16,
};

/**
 * Column/row geometry for the tree. Winners rounds run left to right on
 * top, the losers bracket (double elimination) sits underneath, and the
 * grand final is the final column. Each round's matches are vertically
 * centred on the slots they feed, so connectors run cleanly downhill.
 */
export function computeLayout(bracket: Bracket, options: BracketLayoutOptions = {}): BracketLayout {
  const { matchWidth, matchHeight, roundGap, matchGap } = { ...DEFAULT_LAYOUT, ...options };
  const rowPitch = matchHeight + matchGap;
  const columnPitch = matchWidth + roundGap;

  const winnersHeight = rowPitch * (bracket.size / 2);
  const losersRounds = bracket.format === "double" ? 2 * bracket.rounds - 2 : 0;
  const losersHeight = losersRounds > 0 ? rowPitch * (bracket.size / 4) : 0;
  const gapBetweenBrackets = losersRounds > 0 ? roundGap : 0;
  const totalHeight = winnersHeight + gapBetweenBrackets + losersHeight;
  // Losers rounds run as far right as the winners rounds (or further), so
  // the grand final sits in the last column, after both brackets.
  const columns = bracket.format === "double" ? Math.max(bracket.rounds, losersRounds) + 1 : bracket.rounds;
  const totalWidth = columnPitch * columns - roundGap;

  const positioned = new Map<string, PositionedMatch>();
  const place = (match: BracketMatch, column: number, y: number) => {
    positioned.set(match.id, {
      match,
      x: column * columnPitch,
      y,
      width: matchWidth,
      height: matchHeight,
    });
  };

  for (const match of bracket.matches) {
    if (match.side === "winners") {
      const count = bracket.size / Math.pow(2, match.round + 1);
      const pitch = winnersHeight / count;
      place(match, match.round, pitch * match.position + (pitch - matchHeight) / 2);
    } else if (match.side === "losers") {
      const count = bracket.size / Math.pow(2, Math.floor(match.round / 2) + 2);
      const pitch = losersHeight / count;
      const top = winnersHeight + gapBetweenBrackets;
      place(match, match.round, top + pitch * match.position + (pitch - matchHeight) / 2);
    } else {
      // Grand final / reset: final column, centred on the winners bracket.
      const y = match.round === 0
        ? (winnersHeight - matchHeight) / 2
        : (winnersHeight - matchHeight) / 2 + matchHeight + matchGap;
      place(match, columns - 1, y);
    }
  }

  const connectors: BracketConnector[] = [];
  for (const match of bracket.matches) {
    const from = positioned.get(match.id);
    if (!from) continue;
    const targets: Array<{ id: string | null; slot: BracketSlot | null; kind: "winner" | "loser" }> = [
      { id: match.nextMatchId, slot: match.nextSlot, kind: "winner" },
      { id: match.loserNextMatchId, slot: match.loserNextSlot, kind: "loser" },
    ];
    for (const target of targets) {
      if (!target.id) continue;
      const to = positioned.get(target.id);
      if (!to) continue;
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      const y2 = to.y + (target.slot === "away" ? (3 * to.height) / 4 : to.height / 4);
      const midX = (x1 + x2) / 2;
      connectors.push({
        id: `${match.id}->${target.id}:${target.kind}`,
        fromMatchId: match.id,
        toMatchId: target.id,
        d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
        decided: match.status === "final" && (target.kind === "winner" ? match.winnerId !== null : match.loserId !== null),
      });
    }
  }

  return { matches: [...positioned.values()], connectors, width: totalWidth, height: totalHeight };
}

// ============================================================
// Prediction mode (pure simulation over a bracket snapshot)
// ============================================================

export type BracketPicks = Record<string, string>;

/**
 * Simulate a set of predicted winners without touching real results:
 * each pick fills the picked entrant into the downstream slot, so later
 * rounds show predicted matchups and a predicted champion. Picks for
 * matches whose entrants are unknown, or for entrants not in the match,
 * are ignored. Returns the simulated matches plus the predicted champion.
 */
export function simulatePredictions(
  bracket: Bracket,
  picks: BracketPicks
): { matches: BracketMatch[]; predictedChampionId: string | null } {
  const matches = cloneMatches(bracket.matches);
  const byId = new Map(matches.map((m) => [m.id, m]));
  const ordered = [...matches].sort((a, b) => {
    const sideRank = (s: BracketSide) => (s === "winners" ? 0 : s === "losers" ? 1 : 2);
    return sideRank(a.side) - sideRank(b.side) || a.round - b.round || a.position - b.position;
  });
  for (const match of ordered) {
    const pick = picks[match.id];
    if (!pick) continue;
    const picked = match.home?.id === pick ? match.home : match.away?.id === pick ? match.away : null;
    if (!picked) continue;
    match.predictedWinnerId = pick;
    if (match.nextMatchId) {
      const target = byId.get(match.nextMatchId);
      if (target && !target[match.nextSlot ?? "home"]) {
        target[match.nextSlot ?? "home"] = picked;
      }
    }
    if (match.loserNextMatchId) {
      const loser = match.home?.id === pick ? match.away : match.home;
      const target = byId.get(match.loserNextMatchId);
      if (target && loser && !target[match.loserNextSlot ?? "home"]) {
        target[match.loserNextSlot ?? "home"] = loser;
      }
    }
  }
  const finals = matches.filter((m) => m.side === "final");
  const championSource =
    finals.sort((a, b) => b.round - a.round)[0] ??
    matches.filter((m) => m.side === "winners").sort((a, b) => b.round - a.round)[0];
  const predictedChampionId =
    championSource?.predictedWinnerId ?? championSource?.winnerId ?? null;
  return { matches, predictedChampionId };
}

/**
 * The matches an entrant is predicted to play, in round order, given a set
 * of picks (their actual path so far plus predicted future ties).
 */
export function predictedPath(bracket: Bracket, picks: BracketPicks, entrantId: string): BracketMatch[] {
  const { matches } = simulatePredictions(bracket, picks);
  return matches
    .filter((m) => m.home?.id === entrantId || m.away?.id === entrantId)
    .sort((a, b) => {
      const sideRank = (s: BracketSide) => (s === "winners" ? 0 : s === "losers" ? 1 : 2);
      return sideRank(a.side) - sideRank(b.side) || a.round - b.round || a.position - b.position;
    });
}
