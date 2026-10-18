/**
 * Swiss-system pairing and tie-break engine (issue #270).
 *
 * Pure functions with no database access, so pairing rules and standings can
 * be simulated and unit tested over whole tournaments.
 *
 * Match points: win 3, draw 1, loss 0. A bye scores as a win (3) and is
 * recorded separately; it never counts toward Buchholz or Sonneborn-Berger.
 *
 * Standings order (all descending, then the deterministic fallbacks):
 *   1. match points
 *   2. Buchholz: sum of the match points of every opponent faced
 *   3. Sonneborn-Berger: match points of beaten opponents + half of drawn ones
 *   4. squad points differential in played matches (points for - against)
 *   5. total squad score across all rounds, byes included
 *   6. seed (earlier joiners first), then member id
 */

export type SwissResult = "PENDING" | "A_WIN" | "B_WIN" | "DRAW" | "BYE";

export const SWISS_MATCH_POINTS = { WIN: 3, DRAW: 1, LOSS: 0, BYE: 3 } as const;

export interface SwissMatchRecord {
  round: number;
  playerAId: string;
  /** null for a bye */
  playerBId: string | null;
  scoreA: number | null;
  scoreB: number | null;
  result: SwissResult;
}

export interface SwissStanding {
  memberId: string;
  rank: number;
  matchPoints: number;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  buchholz: number;
  sonnebornBerger: number;
  pointsFor: number;
  pointsAgainst: number;
  pointsDifferential: number;
  totalSquadScore: number;
  opponents: string[];
}

export interface SwissPairingSlot {
  playerAId: string;
  /** null for a bye */
  playerBId: string | null;
  tableNumber: number;
  isRematch: boolean;
}

export interface SwissRoundPlan {
  pairings: SwissPairingSlot[];
  byeMemberId: string | null;
  /** True when no rematch-free pairing exists and the fallback allowed repeats */
  usedRematchFallback: boolean;
}

export interface SwissPairingOptions {
  /** Upper bound on backtracking steps per bye candidate (keeps large fields bounded) */
  stepBudget?: number;
}

/** Rounds needed for a clear winner: ceil(log2(players)), at least 1. */
export function recommendedSwissRounds(playerCount: number): number {
  return playerCount < 2 ? 0 : Math.max(1, Math.ceil(Math.log2(playerCount)));
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Resolves a played board from the two squad scores (higher score wins). */
export function resolveSwissResult(scoreA: number, scoreB: number): Exclude<SwissResult, "PENDING" | "BYE"> {
  if (scoreA > scoreB) return "A_WIN";
  if (scoreB > scoreA) return "B_WIN";
  return "DRAW";
}

function emptyStanding(memberId: string): SwissStanding {
  return {
    memberId,
    rank: 0,
    matchPoints: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    byes: 0,
    buchholz: 0,
    sonnebornBerger: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    pointsDifferential: 0,
    totalSquadScore: 0,
    opponents: [],
  };
}

/**
 * Computes standings from every settled match. Members are included even with
 * no matches yet. `seeds` maps member id to its seed (lower = stronger); members
 * are seeded in the given order when omitted.
 */
export function computeSwissStandings(
  memberIds: string[],
  matches: SwissMatchRecord[],
  seeds: Map<string, number> = new Map(memberIds.map((id, idx) => [id, idx]))
): SwissStanding[] {
  const rows = new Map<string, SwissStanding>(memberIds.map((id) => [id, emptyStanding(id)]));
  const row = (id: string) => {
    let entry = rows.get(id);
    if (!entry) {
      // A member who left mid-tournament still counts toward opponents' tie-breaks
      entry = emptyStanding(id);
      rows.set(id, entry);
    }
    return entry;
  };

  const settled = matches.filter((m) => m.result !== "PENDING");

  // Pass 1: match points, records and squad points
  for (const match of settled) {
    const a = row(match.playerAId);
    a.totalSquadScore += match.scoreA ?? 0;

    if (match.result === "BYE" || match.playerBId === null) {
      a.byes++;
      a.matchPoints += SWISS_MATCH_POINTS.BYE;
      continue;
    }

    const b = row(match.playerBId);
    const scoreA = match.scoreA ?? 0;
    const scoreB = match.scoreB ?? 0;
    b.totalSquadScore += scoreB;
    a.pointsFor += scoreA;
    a.pointsAgainst += scoreB;
    b.pointsFor += scoreB;
    b.pointsAgainst += scoreA;
    a.opponents.push(b.memberId);
    b.opponents.push(a.memberId);

    if (match.result === "A_WIN") {
      a.wins++;
      b.losses++;
      a.matchPoints += SWISS_MATCH_POINTS.WIN;
    } else if (match.result === "B_WIN") {
      b.wins++;
      a.losses++;
      b.matchPoints += SWISS_MATCH_POINTS.WIN;
    } else {
      a.draws++;
      b.draws++;
      a.matchPoints += SWISS_MATCH_POINTS.DRAW;
      b.matchPoints += SWISS_MATCH_POINTS.DRAW;
    }
  }

  // Pass 2: tie-breaks depend on every opponent's final match points
  const points = (id: string) => rows.get(id)?.matchPoints ?? 0;
  for (const match of settled) {
    if (match.playerBId === null || match.result === "BYE") continue;
    const a = rows.get(match.playerAId)!;
    const b = rows.get(match.playerBId)!;
    if (match.result === "A_WIN") a.sonnebornBerger += points(b.memberId);
    else if (match.result === "B_WIN") b.sonnebornBerger += points(a.memberId);
    else {
      a.sonnebornBerger += points(b.memberId) / 2;
      b.sonnebornBerger += points(a.memberId) / 2;
    }
  }
  for (const entry of rows.values()) {
    entry.buchholz = entry.opponents.reduce((sum, id) => sum + points(id), 0);
    entry.pointsDifferential = entry.pointsFor - entry.pointsAgainst;
  }

  const seedOf = (id: string) => seeds.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...rows.values()]
    .filter((entry) => memberIds.includes(entry.memberId))
    .sort(
      (x, y) =>
        y.matchPoints - x.matchPoints ||
        y.buchholz - x.buchholz ||
        y.sonnebornBerger - x.sonnebornBerger ||
        y.pointsDifferential - x.pointsDifferential ||
        y.totalSquadScore - x.totalSquadScore ||
        seedOf(x.memberId) - seedOf(y.memberId) ||
        (x.memberId < y.memberId ? -1 : x.memberId > y.memberId ? 1 : 0)
    )
    .map((entry, idx) => ({ ...entry, rank: idx + 1 }));
}

/**
 * Backtracking search for a perfect matching of `players` (already in standings
 * order) with no repeated pairing. Each player is matched with the closest-ranked
 * opponent they have not met, so score groups pair internally and float down
 * only when they must. Returns null when none exists or the budget runs out.
 */
function pairWithoutRematch(
  players: string[],
  played: Set<string>,
  budget: { steps: number }
): Array<[string, string]> | null {
  if (players.length === 0) return [];
  if (--budget.steps < 0) return null;

  const [top, ...rest] = players;
  for (let i = 0; i < rest.length; i++) {
    const opponent = rest[i];
    if (played.has(pairKey(top, opponent))) continue;
    const remainder = [...rest.slice(0, i), ...rest.slice(i + 1)];
    const tail = pairWithoutRematch(remainder, played, budget);
    if (tail) return [[top, opponent], ...tail];
    if (budget.steps < 0) return null;
  }
  return null;
}

/** Fallback when a rematch is unavoidable: prefer fresh opponents, then the closest-ranked one. */
function pairGreedily(players: string[], played: Set<string>): Array<[string, string]> {
  const pending = [...players];
  const pairs: Array<[string, string]> = [];
  while (pending.length > 1) {
    const top = pending.shift()!;
    let index = pending.findIndex((id) => !played.has(pairKey(top, id)));
    if (index === -1) index = 0;
    pairs.push([top, pending.splice(index, 1)[0]]);
  }
  return pairs;
}

/**
 * Pairs the next Swiss round.
 * - `standings`: active players in current standings order (rank 1 first).
 * - `history`: every pairing already played or scheduled.
 * - With an odd field the bye goes to the lowest-ranked player who has not had
 *   one yet; a higher-ranked candidate is used only if the lower one would make
 *   a rematch-free pairing of everyone else impossible.
 */
export function generateSwissPairings(
  standings: Array<Pick<SwissStanding, "memberId">>,
  history: Array<Pick<SwissMatchRecord, "playerAId" | "playerBId">>,
  options: SwissPairingOptions = {}
): SwissRoundPlan {
  const order = standings.map((s) => s.memberId);
  if (order.length < 2) {
    return {
      pairings: order.map((id) => ({ playerAId: id, playerBId: null, tableNumber: 1, isRematch: false })),
      byeMemberId: order[0] ?? null,
      usedRematchFallback: false,
    };
  }

  const played = new Set<string>();
  const hadBye = new Set<string>();
  for (const match of history) {
    if (match.playerBId) played.add(pairKey(match.playerAId, match.playerBId));
    else hadBye.add(match.playerAId);
  }
  const stepBudget = options.stepBudget ?? 200_000;

  const byeCandidates: Array<string | null> = [];
  if (order.length % 2 === 1) {
    const fromBottom = [...order].reverse();
    const eligible = fromBottom.filter((id) => !hadBye.has(id));
    // Everyone already had a bye only in very long tournaments: fall back to the lowest ranked
    byeCandidates.push(...(eligible.length > 0 ? eligible : fromBottom));
  } else {
    byeCandidates.push(null);
  }

  let chosen: { bye: string | null; pairs: Array<[string, string]> } | null = null;
  for (const bye of byeCandidates) {
    const field = bye ? order.filter((id) => id !== bye) : order;
    const pairs = pairWithoutRematch(field, played, { steps: stepBudget });
    if (pairs) {
      chosen = { bye, pairs };
      break;
    }
  }

  let usedRematchFallback = false;
  if (!chosen) {
    usedRematchFallback = true;
    const bye = byeCandidates[0];
    chosen = { bye, pairs: pairGreedily(bye ? order.filter((id) => id !== bye) : order, played) };
  }

  const rank = new Map(order.map((id, idx) => [id, idx]));
  const pairings: SwissPairingSlot[] = chosen.pairs
    .map(([x, y]) => (rank.get(x)! <= rank.get(y)! ? [x, y] : [y, x]))
    .sort((p, q) => rank.get(p[0])! - rank.get(q[0])!)
    .map(([a, b], idx) => ({
      playerAId: a,
      playerBId: b,
      tableNumber: idx + 1,
      isRematch: played.has(pairKey(a, b)),
    }));
  if (chosen.bye) {
    pairings.push({ playerAId: chosen.bye, playerBId: null, tableNumber: pairings.length + 1, isRematch: false });
  }

  return { pairings, byeMemberId: chosen.bye, usedRematchFallback };
}
