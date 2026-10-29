/**
 * Tournament bracket engine for head-to-head leagues (issue #231).
 *
 * - Round-robin: circle-method schedule where every manager meets every other
 *   manager once per leg, and nobody plays twice in the same round.
 * - Knockout cups: single-elimination brackets for up to 64 managers, using
 *   standard seeding (1 v 64, 32 v 33, ...), so the top two seeds can only meet
 *   in the final. Missing entrants become byes for the top seeds.
 * - Tie-breaks follow the FPL cup rules: most goals scored in the gameweek,
 *   then fewest goals conceded, then a virtual coin toss. The coin toss is a
 *   hash of the league, gameweek and both managers, so it is reproducible.
 *
 * Cup fixtures are stored in `league_fixtures` with `isCup = true`. They are
 * settled here and never count towards the H2H league table.
 */

import { createHash } from "node:crypto";
import { prisma } from "../../config/db.js";
import { MembershipStatus } from "../../types/index.js";

export const KNOCKOUT_BRACKET_SIZES = [2, 4, 8, 16, 32, 64] as const;
export const MAX_KNOCKOUT_PARTICIPANTS = 64;

export class TournamentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TournamentValidationError";
  }
}

// ------------------------------------------------------------
// Round-robin
// ------------------------------------------------------------

export interface RoundRobinMatch {
  home: string;
  /** null = this manager has a bye in this round (odd number of managers). */
  away: string | null;
}

/**
 * Circle-method round-robin. With `legs = 2` the second half repeats the
 * first with home and away swapped. Rounds are returned in play order.
 */
export function generateRoundRobin(participants: string[], legs = 1): RoundRobinMatch[][] {
  if (new Set(participants).size !== participants.length) {
    throw new TournamentValidationError("Participants must be unique");
  }
  if (participants.length < 2) return [];
  if (!Number.isInteger(legs) || legs < 1) {
    throw new TournamentValidationError("legs must be a positive integer");
  }

  const slots: Array<string | null> = [...participants];
  if (slots.length % 2 === 1) slots.push(null);
  const n = slots.length;

  const firstLeg: RoundRobinMatch[][] = [];
  let rotation = [...slots];
  for (let r = 0; r < n - 1; r++) {
    const round: RoundRobinMatch[] = [];
    for (let i = 0; i < n / 2; i++) {
      let home = rotation[i];
      let away = rotation[n - 1 - i];
      // The fixed slot never rotates sides, so alternate its home games by round.
      if (i === 0 && r % 2 === 1) [home, away] = [away, home];
      if (home === null) [home, away] = [away, home];
      round.push({ home: home as string, away });
    }
    firstLeg.push(round);
    // Keep the first slot fixed and rotate the rest clockwise.
    rotation = [rotation[0], rotation[n - 1], ...rotation.slice(1, n - 1)];
  }

  const rounds: RoundRobinMatch[][] = [];
  for (let leg = 0; leg < legs; leg++) {
    for (const round of firstLeg) {
      rounds.push(
        leg % 2 === 0
          ? round
          : round.map((m) => (m.away === null ? m : { home: m.away, away: m.home }))
      );
    }
  }
  return rounds;
}

/**
 * Checks a schedule: nobody appears twice in a round, and each pair meets
 * exactly `legs` times. Returns the problems found (empty when valid).
 */
export function validateRoundRobin(participants: string[], rounds: RoundRobinMatch[][], legs = 1): string[] {
  const problems: string[] = [];
  const meetings = new Map<string, number>();
  rounds.forEach((round, r) => {
    const seen = new Set<string>();
    for (const match of round) {
      for (const id of [match.home, match.away]) {
        if (id === null) continue;
        if (seen.has(id)) problems.push(`round ${r + 1}: ${id} plays twice`);
        seen.add(id);
      }
      if (match.away !== null) {
        const key = [match.home, match.away].sort().join("|");
        meetings.set(key, (meetings.get(key) ?? 0) + 1);
      }
    }
  });
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const key = [participants[i], participants[j]].sort().join("|");
      const count = meetings.get(key) ?? 0;
      if (count !== legs) problems.push(`${key} meet ${count} times, expected ${legs}`);
    }
  }
  return problems;
}

// ------------------------------------------------------------
// Knockout brackets
// ------------------------------------------------------------

/** Smallest supported bracket that fits `count` entrants. */
export function knockoutBracketSize(count: number): number {
  if (count < 2) throw new TournamentValidationError("A knockout bracket needs at least 2 participants");
  if (count > MAX_KNOCKOUT_PARTICIPANTS) {
    throw new TournamentValidationError(`A knockout bracket supports at most ${MAX_KNOCKOUT_PARTICIPANTS} participants`);
  }
  return KNOCKOUT_BRACKET_SIZES.find((size) => size >= count)!;
}

/**
 * Standard bracket order of seeds for a bracket of `size` (a power of two).
 * Size 8 gives [1, 8, 4, 5, 2, 7, 3, 6]: adjacent pairs play each other.
 */
export function standardSeedOrder(size: number): number[] {
  if (!KNOCKOUT_BRACKET_SIZES.includes(size as (typeof KNOCKOUT_BRACKET_SIZES)[number])) {
    throw new TournamentValidationError(`Unsupported bracket size ${size}`);
  }
  let order = [1, 2];
  while (order.length < size) {
    const total = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, total - seed]);
  }
  return order;
}

export interface KnockoutPairing {
  /** 0-based position in the round; winners of slots 2k and 2k+1 meet in slot k next round. */
  slot: number;
  home: string;
  /** null = bye: the home manager advances without playing. */
  away: string | null;
  homeSeed: number;
  awaySeed: number | null;
}

/**
 * First-round pairings for seeded entrants (best first). The better seed is
 * the home side. Top seeds receive byes when the field is not a power of two.
 */
export function generateKnockoutFirstRound(seededParticipants: string[]): KnockoutPairing[] {
  if (new Set(seededParticipants).size !== seededParticipants.length) {
    throw new TournamentValidationError("Participants must be unique");
  }
  const size = knockoutBracketSize(seededParticipants.length);
  const order = standardSeedOrder(size);
  const pairings: KnockoutPairing[] = [];
  for (let slot = 0; slot < size / 2; slot++) {
    const [a, b] = [order[slot * 2], order[slot * 2 + 1]];
    const [better, worse] = a < b ? [a, b] : [b, a];
    const home = seededParticipants[better - 1];
    const away = seededParticipants[worse - 1] ?? null;
    pairings.push({ slot, home, away, homeSeed: better, awaySeed: away === null ? null : worse });
  }
  return pairings;
}

/** Number of rounds in a bracket of `size` (8 → 3: quarter-final, semi-final, final). */
export function knockoutRoundCount(size: number): number {
  return Math.log2(size);
}

export function knockoutRoundName(round: number, totalRounds: number): string {
  const remaining = totalRounds - round;
  if (remaining === 0) return "Final";
  if (remaining === 1) return "Semi-final";
  if (remaining === 2) return "Quarter-final";
  return `Round of ${2 ** (remaining + 1)}`;
}

// ------------------------------------------------------------
// Tie-breaks
// ------------------------------------------------------------

export interface TieBreakStats {
  /** Goals scored by the manager's players in the gameweek. */
  goalsScored: number;
  /** Goals conceded by the manager's players in the gameweek. */
  goalsConceded: number;
}

export type TieBreakReason = "score" | "goals_scored" | "goals_conceded" | "coin_toss" | "bye";

export interface MatchResolution {
  winner: string;
  loser: string | null;
  reason: TieBreakReason;
}

/**
 * Deterministic "virtual coin toss": the same league, gameweek and pair of
 * managers always produce the same winner, independent of home/away order.
 */
export function virtualCoinToss(seed: string, a: string, b: string): string {
  const [first, second] = [a, b].sort();
  const digest = createHash("sha256").update(`${seed}:${first}:${second}`).digest();
  return digest[0] % 2 === 0 ? first : second;
}

/**
 * Picks the winner of a knockout match using the FPL cup order:
 * points, then goals scored, then fewest goals conceded, then a coin toss.
 */
export function resolveKnockoutMatch(input: {
  home: string;
  away: string | null;
  homeScore: number;
  awayScore: number;
  homeStats?: TieBreakStats;
  awayStats?: TieBreakStats;
  coinTossSeed: string;
}): MatchResolution {
  const { home, away } = input;
  if (away === null) return { winner: home, loser: null, reason: "bye" };
  if (input.homeScore !== input.awayScore) {
    return input.homeScore > input.awayScore
      ? { winner: home, loser: away, reason: "score" }
      : { winner: away, loser: home, reason: "score" };
  }
  const hs = input.homeStats ?? { goalsScored: 0, goalsConceded: 0 };
  const as = input.awayStats ?? { goalsScored: 0, goalsConceded: 0 };
  if (hs.goalsScored !== as.goalsScored) {
    return hs.goalsScored > as.goalsScored
      ? { winner: home, loser: away, reason: "goals_scored" }
      : { winner: away, loser: home, reason: "goals_scored" };
  }
  if (hs.goalsConceded !== as.goalsConceded) {
    return hs.goalsConceded < as.goalsConceded
      ? { winner: home, loser: away, reason: "goals_conceded" }
      : { winner: away, loser: home, reason: "goals_conceded" };
  }
  const winner = virtualCoinToss(input.coinTossSeed, home, away);
  return { winner, loser: winner === home ? away : home, reason: "coin_toss" };
}

/** Pairs winners of adjacent slots (2k, 2k+1) into slot k of the next round. */
export function nextRoundPairings(winnersBySlot: string[]): Array<{ slot: number; home: string; away: string }> {
  if (winnersBySlot.length < 2 || winnersBySlot.length % 2 !== 0) {
    throw new TournamentValidationError("A knockout round needs an even number of winners");
  }
  const pairings: Array<{ slot: number; home: string; away: string }> = [];
  for (let slot = 0; slot < winnersBySlot.length / 2; slot++) {
    pairings.push({ slot, home: winnersBySlot[slot * 2], away: winnersBySlot[slot * 2 + 1] });
  }
  return pairings;
}

// ------------------------------------------------------------
// Persistence
// ------------------------------------------------------------

/** Loads goals scored / conceded per squad for one gameweek. */
export type TieBreakStatsLoader = (
  squadIds: string[],
  gameweekId: number
) => Promise<Map<string, TieBreakStats>>;

export interface KnockoutSettlementResult {
  settled: number;
  /** Set when the settled round was complete and the next round was created. */
  nextRound?: { round: number; gameweekId: number; pairings: Array<{ slot: number; home: string; away: string }> };
  /** Set when the final was settled. */
  champion?: string;
}

export class TournamentBracketService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma, private readonly loadTieBreakStats?: TieBreakStatsLoader) {}

  /**
   * Default tie-break loader: sums goals and goals conceded of each squad's
   * starting players for the gameweek.
   */
  private async defaultTieBreakStats(squadIds: string[], gameweekId: number): Promise<Map<string, TieBreakStats>> {
    const starters = await this.db.squadPlayer.findMany({
      where: { squadId: { in: squadIds }, isStarter: true },
      select: { squadId: true, playerId: true },
    });
    const stats = await this.db.playerGameweekStats.findMany({
      where: { gameweekId, playerId: { in: [...new Set(starters.map((s: { playerId: number }) => s.playerId))] } },
      select: { playerId: true, goals: true, goalsConceded: true },
    });
    const byPlayer = new Map<number, TieBreakStats>();
    for (const s of stats) {
      const current = byPlayer.get(s.playerId) ?? { goalsScored: 0, goalsConceded: 0 };
      current.goalsScored += s.goals;
      current.goalsConceded += s.goalsConceded;
      byPlayer.set(s.playerId, current);
    }
    const bySquad = new Map<string, TieBreakStats>(squadIds.map((id) => [id, { goalsScored: 0, goalsConceded: 0 }]));
    for (const { squadId, playerId } of starters) {
      const squad = bySquad.get(squadId)!;
      const player = byPlayer.get(playerId);
      if (player) {
        squad.goalsScored += player.goalsScored;
        squad.goalsConceded += player.goalsConceded;
      }
    }
    return bySquad;
  }

  /**
   * Creates the first round of a knockout cup on `startGameweekId`. Later
   * rounds are created as each round is settled, one gameweek apart.
   * Without `seededMemberIds`, active members are seeded by current rank.
   */
  public async createKnockoutCup(
    leagueId: string,
    options: { startGameweekId: number; seededMemberIds?: string[] }
  ): Promise<{ bracketSize: number; rounds: number; finalGameweekId: number; pairings: KnockoutPairing[] }> {
    const league = await this.db.league.findUnique({ where: { id: leagueId } });
    if (!league) throw new TournamentValidationError(`League ${leagueId} not found`);

    const members = await this.db.leagueMember.findMany({
      where: { leagueId, status: MembershipStatus.ACTIVE },
      orderBy: [{ h2hPoints: "desc" }, { totalPoints: "desc" }, { pointsFor: "desc" }, { joinedAt: "asc" }],
      select: { id: true },
    });
    const memberIds: string[] = members.map((m: { id: string }) => m.id);
    let seeds: string[];
    if (options.seededMemberIds) {
      const known = new Set(memberIds);
      const unknown = options.seededMemberIds.filter((id) => !known.has(id));
      if (unknown.length) throw new TournamentValidationError(`Not active league members: ${unknown.join(", ")}`);
      seeds = options.seededMemberIds;
    } else {
      seeds = memberIds.slice(0, MAX_KNOCKOUT_PARTICIPANTS);
    }

    const pairings = generateKnockoutFirstRound(seeds);
    const bracketSize = knockoutBracketSize(seeds.length);
    const rounds = knockoutRoundCount(bracketSize);
    const finalGameweekId = options.startGameweekId + rounds - 1;
    if (options.startGameweekId < league.startGameweekId || finalGameweekId > league.endGameweekId) {
      throw new TournamentValidationError(
        `A ${rounds}-round cup starting in gameweek ${options.startGameweekId} does not fit the league's gameweeks`
      );
    }

    const existing = await this.db.leagueFixture.count({ where: { leagueId, isCup: true } });
    if (existing > 0) throw new TournamentValidationError("This league already has a knockout cup");

    await this.db.leagueFixture.createMany({
      data: pairings.map((p) => ({
        leagueId,
        gameweekId: options.startGameweekId,
        homeMemberId: p.home,
        awayMemberId: p.away,
        isCup: true,
        playoffRound: 1,
        playoffSlot: p.slot,
      })),
    });

    return { bracketSize, rounds, finalGameweekId, pairings };
  }

  /**
   * Settles the league's cup fixtures for a gameweek: records scores, picks
   * winners with the FPL tie-break rules, and creates the next round (one
   * gameweek later) once the round is complete. Safe to call when the league
   * has no cup fixtures in this gameweek.
   */
  public async settleKnockoutGameweek(
    leagueId: string,
    gameweekId: number,
    useLeagueScoring = false
  ): Promise<KnockoutSettlementResult> {
    const fixtures = await this.db.leagueFixture.findMany({
      where: { leagueId, gameweekId, isCup: true, isFinished: false },
    });
    if (fixtures.length === 0) return { settled: 0 };

    const memberIds = [
      ...new Set<string>(fixtures.flatMap((f: any) => [f.homeMemberId, f.awayMemberId].filter(Boolean))),
    ];
    const members = await this.db.leagueMember.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, squadId: true },
    });
    const squadByMember = new Map<string, string>(members.map((m: any) => [m.id, m.squadId]));
    const squadIds = [...squadByMember.values()];

    const scores = useLeagueScoring
      ? await this.db.leagueGameweekScore.findMany({ where: { leagueId, gameweekId, squadId: { in: squadIds } } })
      : await this.db.squadGameweekScore.findMany({ where: { gameweekId, squadId: { in: squadIds } } });
    const pointsBySquad = new Map<string, number>(scores.map((s: any) => [s.squadId, s.points]));
    const scoreOf = (memberId: string) => pointsBySquad.get(squadByMember.get(memberId) ?? "") ?? 0;

    const tied = fixtures.some((f: any) => f.awayMemberId && scoreOf(f.homeMemberId) === scoreOf(f.awayMemberId));
    const tieStats = tied
      ? await (this.loadTieBreakStats ?? this.defaultTieBreakStats.bind(this))(squadIds, gameweekId)
      : new Map<string, TieBreakStats>();
    const statsOf = (memberId: string) => tieStats.get(squadByMember.get(memberId) ?? "");

    await this.db.$transaction(async (tx: any) => {
      for (const fixture of fixtures) {
        const homeScore = scoreOf(fixture.homeMemberId);
        const awayScore = fixture.awayMemberId ? scoreOf(fixture.awayMemberId) : null;
        const resolution = resolveKnockoutMatch({
          home: fixture.homeMemberId,
          away: fixture.awayMemberId,
          homeScore,
          awayScore: awayScore ?? 0,
          homeStats: statsOf(fixture.homeMemberId),
          awayStats: fixture.awayMemberId ? statsOf(fixture.awayMemberId) : undefined,
          coinTossSeed: `${leagueId}:${gameweekId}`,
        });
        await tx.leagueFixture.update({
          where: { id: fixture.id },
          data: {
            homeScore,
            awayScore,
            isFinished: true,
            winnerMemberId: resolution.winner,
            tiebreakReason: resolution.reason,
          },
        });
      }
    });

    const advance = await this.advanceKnockoutRound(leagueId, gameweekId);
    return { settled: fixtures.length, ...advance };
  }

  /**
   * Creates the next round when every cup fixture of the gameweek's round is
   * finished. Returns the champion after the final.
   */
  public async advanceKnockoutRound(
    leagueId: string,
    gameweekId: number
  ): Promise<Omit<KnockoutSettlementResult, "settled">> {
    const round = await this.db.leagueFixture.findMany({
      where: { leagueId, gameweekId, isCup: true },
    });
    if (round.length === 0 || round.some((f: any) => !f.isFinished)) return {};

    const bySlot = [...round].sort((a: any, b: any) => (a.playoffSlot ?? 0) - (b.playoffSlot ?? 0));
    const winners: string[] = bySlot.map((f: any) => f.winnerMemberId ?? f.homeMemberId);
    if (winners.length === 1) return { champion: winners[0] };

    const nextRound = (bySlot[0].playoffRound ?? 1) + 1;
    const nextGameweekId = gameweekId + 1;
    const already = await this.db.leagueFixture.count({
      where: { leagueId, gameweekId: nextGameweekId, isCup: true },
    });
    if (already > 0) return {};

    const pairings = nextRoundPairings(winners);
    await this.db.leagueFixture.createMany({
      data: pairings.map((p) => ({
        leagueId,
        gameweekId: nextGameweekId,
        homeMemberId: p.home,
        awayMemberId: p.away,
        isCup: true,
        playoffRound: nextRound,
        playoffSlot: p.slot,
      })),
    });
    return { nextRound: { round: nextRound, gameweekId: nextGameweekId, pairings } };
  }

  /** Cup bracket for display, grouped by round. */
  public async getKnockoutBracket(leagueId: string) {
    const fixtures = await this.db.leagueFixture.findMany({
      where: { leagueId, isCup: true },
      orderBy: [{ playoffRound: "asc" }, { playoffSlot: "asc" }],
    });
    if (fixtures.length === 0) return { rounds: [] as unknown[], champion: null as string | null };
    const firstRoundSize = fixtures.filter((f: any) => f.playoffRound === 1).length;
    const totalRounds = Math.log2(firstRoundSize * 2);
    const roundsMap = new Map<number, any[]>();
    for (const f of fixtures) {
      const list = roundsMap.get(f.playoffRound) ?? [];
      list.push(f);
      roundsMap.set(f.playoffRound, list);
    }
    const rounds = [...roundsMap.entries()].map(([round, list]) => ({
      round,
      name: knockoutRoundName(round, totalRounds),
      gameweekId: list[0].gameweekId,
      fixtures: list,
    }));
    const final = roundsMap.get(totalRounds)?.[0];
    return { rounds, champion: final?.isFinished ? final.winnerMemberId : null };
  }
}

export const tournamentBracketService = new TournamentBracketService();
