import crypto from "crypto";
import { prisma } from "../../config/db.js";
import { MembershipStatus, ScoringType } from "../../types/index.js";

/**
 * Supported knockout tournament bracket sizes (powers of two from 8 to 64).
 */
export const SUPPORTED_KNOCKOUT_BRACKET_SIZES = [8, 16, 32, 64] as const;
export type KnockoutBracketSize = (typeof SUPPORTED_KNOCKOUT_BRACKET_SIZES)[number];

export type TieBreakMethod =
  | "SCORE"
  | "GOALS_SCORED"
  | "GOALS_CONCEDED"
  | "COIN_TOSS";

export interface RoundRobinMatchup {
  round: number;
  gameweekId: number;
  homeMemberId: string;
  awayMemberId: string | null;
}

export interface SquadTieBreakStats {
  memberId: string;
  goalsScored: number;
  goalsConceded: number;
}

export interface KnockoutMatchSlot {
  id?: string;
  round: number;
  roundName: string;
  slot: number;
  gameweekId: number;
  homeMemberId: string;
  awayMemberId: string;
  homeSeed?: number;
  awaySeed?: number;
  homeScore?: number | null;
  awayScore?: number | null;
  winnerMemberId?: string | null;
  tieBreakMethod?: TieBreakMethod | null;
  isFinished: boolean;
}

export interface KnockoutRoundSchedule {
  round: number;
  roundName: string;
  gameweekId: number;
  matches: KnockoutMatchSlot[];
}

export interface TournamentBracketStructure {
  leagueId: string;
  bracketSize: KnockoutBracketSize;
  totalRounds: number;
  startGameweekId: number;
  endGameweekId: number;
  rounds: KnockoutRoundSchedule[];
}

export interface TieBreakResolution {
  winnerMemberId: string;
  loserMemberId: string;
  method: TieBreakMethod;
  homeScore: number;
  awayScore: number;
  homeGoalsScored?: number;
  awayGoalsScored?: number;
  homeGoalsConceded?: number;
  awayGoalsConceded?: number;
}

export class TournamentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TournamentValidationError";
  }
}

/**
 * Tournament Bracket & H2H Scheduling Service.
 *
 * Implements:
 * 1. Balanced round-robin pairing generation using the circle algorithm so every manager
 *    faces every other manager an equal number of times without duplicate matchups in a round.
 * 2. Single-elimination knockout bracket generation for 8, 16, 32, or 64 seeded participants
 *    using standard tournament bracket tree placement (Seed 1 vs Seed N, top seeds separated).
 * 3. Official FPL H2H knockout tie-breaking hierarchy:
 *    - Most goals scored by the starting squad in the gameweek
 *    - Fewest goals conceded by the starting squad in the gameweek
 *    - Deterministic virtual coin toss
 * 4. Automatic knockout progression advancing round winners into subsequent bracket slots
 *    through to the Final.
 */
export class TournamentBracketService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma) {}

  /**
   * Returns a human-readable round label (e.g., "Round of 16", "Quarter-Finals", "Semi-Finals", "Final").
   */
  public static getRoundName(participantsInRound: number): string {
    switch (participantsInRound) {
      case 64:
        return "Round of 64";
      case 32:
        return "Round of 32";
      case 16:
        return "Round of 16";
      case 8:
        return "Quarter-Finals";
      case 4:
        return "Semi-Finals";
      case 2:
        return "Final";
      default:
        return `Round of ${participantsInRound}`;
    }
  }

  /**
   * Validates that the participant count is one of the supported single-elimination
   * tournament sizes (8, 16, 32, or 64).
   */
  public static assertValidKnockoutSize(size: number): asserts size is KnockoutBracketSize {
    if (!SUPPORTED_KNOCKOUT_BRACKET_SIZES.includes(size as KnockoutBracketSize)) {
      throw new TournamentValidationError(
        `Invalid knockout bracket size ${size}. Supported sizes are 8, 16, 32, or 64 participants.`
      );
    }
  }

  /**
   * Generates standard tournament bracket seed placement order for a power-of-two size.
   * For example:
   * - size 8  -> [1, 8, 4, 5, 2, 7, 3, 6] (1-indexed seeds)
   * - size 16 -> [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]
   * This ensures Seed 1 and Seed 2 are on opposite halves of the bracket and can only meet in the Final.
   */
  public static buildStandardSeedOrder(bracketSize: KnockoutBracketSize): number[] {
    TournamentBracketService.assertValidKnockoutSize(bracketSize);
    let seeds = [1, 2];
    const rounds = Math.log2(bracketSize);
    for (let r = 1; r < rounds; r++) {
      const nextSeeds: number[] = [];
      const sum = Math.pow(2, r + 1) + 1;
      for (const seed of seeds) {
        nextSeeds.push(seed);
        nextSeeds.push(sum - seed);
      }
      seeds = nextSeeds;
    }
    return seeds;
  }

  /**
   * Generates a balanced round-robin schedule using the circle algorithm.
   * - Every participant plays every other participant once per full cycle (N-1 rounds for even N).
   * - If participant count is odd, a `null` ("Average" / bye) slot is appended.
   * - No manager ever has duplicate match-ups in the same gameweek round.
   * - Across multiple cycles, home/away assignments alternate fairly.
   */
  public static generateRoundRobinSchedule(
    memberIds: string[],
    gameweekIds: number[]
  ): RoundRobinMatchup[] {
    const uniqueIds = [...new Set(memberIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length < 2) {
      throw new TournamentValidationError(
        "At least 2 unique participants are required to generate a round-robin schedule"
      );
    }
    if (uniqueIds.length !== memberIds.length) {
      throw new TournamentValidationError(
        "Duplicate participant IDs are not allowed in round-robin schedule generation"
      );
    }
    if (gameweekIds.length === 0) {
      return [];
    }

    const roster: Array<string | null> = [...uniqueIds];
    if (roster.length % 2 === 1) {
      roster.push(null);
    }

    const n = roster.length;
    const roundsPerCycle = n - 1;
    const matchesPerRound = n / 2;

    const baseCycleRounds: Array<Array<[string | null, string | null]>> = [];
    let rotation = [...roster];

    for (let r = 0; r < roundsPerCycle; r++) {
      const roundPairs: Array<[string | null, string | null]> = [];
      for (let i = 0; i < matchesPerRound; i++) {
        const first = rotation[i];
        const second = rotation[n - 1 - i];
        if (i === 0) {
          roundPairs.push(r % 2 === 0 ? [first, second] : [second, first]);
        } else {
          roundPairs.push((r + i) % 2 === 0 ? [first, second] : [second, first]);
        }
      }
      baseCycleRounds.push(roundPairs);
      // Keep index 0 fixed and rotate remaining participants clockwise
      rotation = [rotation[0], rotation[n - 1], ...rotation.slice(1, n - 1)];
    }

    const schedule: RoundRobinMatchup[] = [];
    gameweekIds.forEach((gameweekId, gwIndex) => {
      const cycleIndex = Math.floor(gwIndex / roundsPerCycle);
      const roundInCycle = gwIndex % roundsPerCycle;
      const flipHomeAway = cycleIndex % 2 === 1;
      const pairs = baseCycleRounds[roundInCycle];

      for (const [a, b] of pairs) {
        let home = flipHomeAway ? b : a;
        let away = flipHomeAway ? a : b;
        if (home === null) {
          [home, away] = [away, home];
        }
        schedule.push({
          round: gwIndex + 1,
          gameweekId,
          homeMemberId: home as string,
          awayMemberId: away,
        });
      }
    });

    return schedule;
  }

  /**
   * Generates a single-elimination knockout bracket for 8, 16, 32, or 64 seeded participants.
   */
  public static generateKnockoutBracket(params: {
    leagueId: string;
    seededMemberIds: string[];
    startGameweekId: number;
  }): TournamentBracketStructure {
    const { leagueId, seededMemberIds, startGameweekId } = params;
    const count = seededMemberIds.length;
    TournamentBracketService.assertValidKnockoutSize(count);

    const uniqueSeeds = new Set(seededMemberIds);
    if (uniqueSeeds.size !== count) {
      throw new TournamentValidationError(
        "Knockout bracket participants must all have unique member IDs"
      );
    }

    const totalRounds = Math.log2(count);
    const seedOrder = TournamentBracketService.buildStandardSeedOrder(count);

    const round1Matches: KnockoutMatchSlot[] = [];
    for (let slot = 0; slot < count / 2; slot++) {
      const homeSeed = seedOrder[slot * 2];
      const awaySeed = seedOrder[slot * 2 + 1];
      round1Matches.push({
        round: 1,
        roundName: TournamentBracketService.getRoundName(count),
        slot,
        gameweekId: startGameweekId,
        homeMemberId: seededMemberIds[homeSeed - 1],
        awayMemberId: seededMemberIds[awaySeed - 1],
        homeSeed,
        awaySeed,
        homeScore: null,
        awayScore: null,
        winnerMemberId: null,
        tieBreakMethod: null,
        isFinished: false,
      });
    }

    const rounds: KnockoutRoundSchedule[] = [
      {
        round: 1,
        roundName: TournamentBracketService.getRoundName(count),
        gameweekId: startGameweekId,
        matches: round1Matches,
      },
    ];

    for (let r = 2; r <= totalRounds; r++) {
      const participantsInRound = count / Math.pow(2, r - 1);
      const matchCount = participantsInRound / 2;
      const gwId = startGameweekId + r - 1;
      const roundName = TournamentBracketService.getRoundName(participantsInRound);
      const placeholderMatches: KnockoutMatchSlot[] = [];

      for (let slot = 0; slot < matchCount; slot++) {
        placeholderMatches.push({
          round: r,
          roundName,
          slot,
          gameweekId: gwId,
          homeMemberId: "",
          awayMemberId: "",
          homeScore: null,
          awayScore: null,
          winnerMemberId: null,
          tieBreakMethod: null,
          isFinished: false,
        });
      }

      rounds.push({
        round: r,
        roundName,
        gameweekId: gwId,
        matches: placeholderMatches,
      });
    }

    return {
      leagueId,
      bracketSize: count,
      totalRounds,
      startGameweekId,
      endGameweekId: startGameweekId + totalRounds - 1,
      rounds,
    };
  }

  /**
   * Deterministic virtual coin toss used as the final FPL tie-breaker when
   * gameweek points, goals scored, and goals conceded are all equal.
   */
  public static virtualCoinToss(
    homeMemberId: string,
    awayMemberId: string,
    contextKey: string = ""
  ): string {
    const digest = crypto
      .createHash("sha256")
      .update(`${contextKey}:${homeMemberId}:${awayMemberId}`)
      .digest();
    const value = digest.readUInt32BE(0);
    return value % 2 === 0 ? homeMemberId : awayMemberId;
  }

  /**
   * Resolves a knockout match winner using the official FPL tie-breaking hierarchy:
   * 1. Higher gameweek match score (`homeScore` vs `awayScore`)
   * 2. Most goals scored by the squad in the gameweek (`homeGoalsScored` vs `awayGoalsScored`)
   * 3. Fewest goals conceded by the squad in the gameweek (`homeGoalsConceded` vs `awayGoalsConceded`)
   * 4. Deterministic virtual coin toss
   */
  public static resolveMatchWithTieBreaker(params: {
    homeMemberId: string;
    awayMemberId: string;
    homeScore: number;
    awayScore: number;
    homeGoalsScored?: number;
    awayGoalsScored?: number;
    homeGoalsConceded?: number;
    awayGoalsConceded?: number;
    fixtureKey?: string;
  }): TieBreakResolution {
    const {
      homeMemberId,
      awayMemberId,
      homeScore,
      awayScore,
      homeGoalsScored = 0,
      awayGoalsScored = 0,
      homeGoalsConceded = 0,
      awayGoalsConceded = 0,
      fixtureKey = `${homeMemberId}-vs-${awayMemberId}`,
    } = params;

    if (homeScore !== awayScore) {
      const homeWins = homeScore > awayScore;
      return {
        winnerMemberId: homeWins ? homeMemberId : awayMemberId,
        loserMemberId: homeWins ? awayMemberId : homeMemberId,
        method: "SCORE",
        homeScore,
        awayScore,
        homeGoalsScored,
        awayGoalsScored,
        homeGoalsConceded,
        awayGoalsConceded,
      };
    }

    // Tie-breaker 1: Most goals scored in the gameweek
    if (homeGoalsScored !== awayGoalsScored) {
      const homeWins = homeGoalsScored > awayGoalsScored;
      return {
        winnerMemberId: homeWins ? homeMemberId : awayMemberId,
        loserMemberId: homeWins ? awayMemberId : homeMemberId,
        method: "GOALS_SCORED",
        homeScore,
        awayScore,
        homeGoalsScored,
        awayGoalsScored,
        homeGoalsConceded,
        awayGoalsConceded,
      };
    }

    // Tie-breaker 2: Fewest goals conceded in the gameweek
    if (homeGoalsConceded !== awayGoalsConceded) {
      const homeWins = homeGoalsConceded < awayGoalsConceded;
      return {
        winnerMemberId: homeWins ? homeMemberId : awayMemberId,
        loserMemberId: homeWins ? awayMemberId : homeMemberId,
        method: "GOALS_CONCEDED",
        homeScore,
        awayScore,
        homeGoalsScored,
        awayGoalsScored,
        homeGoalsConceded,
        awayGoalsConceded,
      };
    }

    // Tie-breaker 3: Virtual coin toss
    const winnerMemberId = TournamentBracketService.virtualCoinToss(
      homeMemberId,
      awayMemberId,
      fixtureKey
    );
    const loserMemberId = winnerMemberId === homeMemberId ? awayMemberId : homeMemberId;

    return {
      winnerMemberId,
      loserMemberId,
      method: "COIN_TOSS",
      homeScore,
      awayScore,
      homeGoalsScored,
      awayGoalsScored,
      homeGoalsConceded,
      awayGoalsConceded,
    };
  }

  /**
   * Settles a knockout round's matches and automatically advances winners into the next round's
   * bracket slots (or crowns the tournament champion when the Final is settled).
   */
  public static progressBracketRound(params: {
    bracket: TournamentBracketStructure;
    round: number;
    results: Array<{
      slot: number;
      homeScore: number;
      awayScore: number;
      homeGoalsScored?: number;
      awayGoalsScored?: number;
      homeGoalsConceded?: number;
      awayGoalsConceded?: number;
    }>;
  }): {
    bracket: TournamentBracketStructure;
    settledMatches: KnockoutMatchSlot[];
    nextRound: KnockoutRoundSchedule | null;
    championMemberId: string | null;
  } {
    const { bracket, round, results } = params;
    const roundSchedule = bracket.rounds.find((r) => r.round === round);
    if (!roundSchedule) {
      throw new TournamentValidationError(`Round ${round} does not exist in bracket`);
    }

    if (results.length !== roundSchedule.matches.length) {
      throw new TournamentValidationError(
        `Expected ${roundSchedule.matches.length} match results for round ${round}, received ${results.length}`
      );
    }

    const resultBySlot = new Map(results.map((r) => [r.slot, r]));
    const settledMatches: KnockoutMatchSlot[] = [];

    for (const match of roundSchedule.matches) {
      if (!match.homeMemberId || !match.awayMemberId) {
        throw new TournamentValidationError(
          `Match slot ${match.slot} in round ${round} does not have both participants assigned`
        );
      }
      const res = resultBySlot.get(match.slot);
      if (!res) {
        throw new TournamentValidationError(
          `Missing result for match slot ${match.slot} in round ${round}`
        );
      }

      const resolution = TournamentBracketService.resolveMatchWithTieBreaker({
        homeMemberId: match.homeMemberId,
        awayMemberId: match.awayMemberId,
        homeScore: res.homeScore,
        awayScore: res.awayScore,
        homeGoalsScored: res.homeGoalsScored,
        awayGoalsScored: res.awayGoalsScored,
        homeGoalsConceded: res.homeGoalsConceded,
        awayGoalsConceded: res.awayGoalsConceded,
        fixtureKey: `${bracket.leagueId}:r${round}:s${match.slot}`,
      });

      match.homeScore = res.homeScore;
      match.awayScore = res.awayScore;
      match.winnerMemberId = resolution.winnerMemberId;
      match.tieBreakMethod = resolution.method;
      match.isFinished = true;
      settledMatches.push({ ...match });
    }

    // If this was the final round, crown the champion
    if (round === bracket.totalRounds) {
      return {
        bracket,
        settledMatches,
        nextRound: null,
        championMemberId: settledMatches[0]?.winnerMemberId ?? null,
      };
    }

    const nextRoundSchedule = bracket.rounds.find((r) => r.round === round + 1);
    if (!nextRoundSchedule) {
      throw new TournamentValidationError(`Next round ${round + 1} missing from bracket`);
    }

    // Sort settled matches by slot so adjacent pairs feed into slot/2 of next round
    const orderedSettled = [...settledMatches].sort((a, b) => a.slot - b.slot);
    for (let i = 0; i < orderedSettled.length; i += 2) {
      const targetSlot = i / 2;
      const nextMatch = nextRoundSchedule.matches[targetSlot];
      nextMatch.homeMemberId = orderedSettled[i].winnerMemberId!;
      nextMatch.awayMemberId = orderedSettled[i + 1].winnerMemberId!;
    }

    return {
      bracket,
      settledMatches,
      nextRound: nextRoundSchedule,
      championMemberId: null,
    };
  }

  /**
   * Persists a generated Round 1 knockout bracket into `league_fixtures` for a head-to-head league.
   */
  public async createPersistentKnockoutBracket(
    leagueId: string,
    bracketSize: KnockoutBracketSize,
    startGameweekId?: number
  ): Promise<TournamentBracketStructure> {
    TournamentBracketService.assertValidKnockoutSize(bracketSize);

    const league = await this.db.league.findUnique({
      where: { id: leagueId },
    });
    if (!league) {
      throw new TournamentValidationError(`League ${leagueId} not found`);
    }
    if (league.scoringType !== ScoringType.HEAD_TO_HEAD) {
      throw new TournamentValidationError("League must use HEAD_TO_HEAD scoring for knockout brackets");
    }

    const members = await this.db.leagueMember.findMany({
      where: { leagueId, status: MembershipStatus.ACTIVE },
    });

    if (members.length < bracketSize) {
      throw new TournamentValidationError(
        `League has ${members.length} active members, but ${bracketSize} are required for this bracket`
      );
    }

    const sortedMembers = [...members].sort(
      (a: any, b: any) =>
        (b.h2hPoints ?? 0) - (a.h2hPoints ?? 0) ||
        (b.pointsFor ?? 0) - (a.pointsFor ?? 0) ||
        (b.pointsFor ?? 0) - (b.pointsAgainst ?? 0) - ((a.pointsFor ?? 0) - (a.pointsAgainst ?? 0))
    );

    const seededIds = sortedMembers.slice(0, bracketSize).map((m: any) => m.id);
    const totalRounds = Math.log2(bracketSize);
    const firstGw = startGameweekId ?? league.endGameweekId - totalRounds + 1;

    const structure = TournamentBracketService.generateKnockoutBracket({
      leagueId,
      seededMemberIds: seededIds,
      startGameweekId: firstGw,
    });

    const round1 = structure.rounds[0];
    await this.db.$transaction(async (tx: any) => {
      await tx.leagueFixture.deleteMany({
        where: { leagueId, gameweekId: round1.gameweekId, isFinished: false },
      });
      await tx.leagueFixture.createMany({
        data: round1.matches.map((m) => ({
          leagueId,
          gameweekId: m.gameweekId,
          homeMemberId: m.homeMemberId,
          awayMemberId: m.awayMemberId,
          isPlayoff: true,
          playoffRound: 1,
          playoffSlot: m.slot,
        })),
      });
    });

    return structure;
  }

  /**
   * Settles a persisted knockout round in the database and creates the next round's fixtures
   * using the official FPL tie-breaking hierarchy.
   */
  public async settleAndAdvancePersistedRound(
    leagueId: string,
    gameweekId: number,
    tieBreakStatsByMember: Map<string, SquadTieBreakStats> = new Map()
  ): Promise<
    | { championMemberId: string; settledCount: number }
    | { nextGameweekId: number; nextRound: number; pairings: Array<{ homeMemberId: string; awayMemberId: string }> }
  > {
    const fixtures = await this.db.leagueFixture.findMany({
      where: { leagueId, gameweekId, isPlayoff: true },
    });

    if (fixtures.length === 0) {
      throw new TournamentValidationError(
        `No knockout fixtures found for league ${leagueId} in gameweek ${gameweekId}`
      );
    }

    const ordered = [...fixtures].sort(
      (a: any, b: any) => (a.playoffSlot ?? 0) - (b.playoffSlot ?? 0)
    );

    const winners: string[] = [];
    for (const fx of ordered) {
      if (!fx.isFinished || fx.homeScore === null || fx.awayScore === null) {
        throw new TournamentValidationError(
          `Fixture ${fx.id} in gameweek ${gameweekId} is not yet settled`
        );
      }

      const homeStats = tieBreakStatsByMember.get(fx.homeMemberId);
      const awayStats = tieBreakStatsByMember.get(fx.awayMemberId);

      const resolution = TournamentBracketService.resolveMatchWithTieBreaker({
        homeMemberId: fx.homeMemberId,
        awayMemberId: fx.awayMemberId,
        homeScore: fx.homeScore,
        awayScore: fx.awayScore,
        homeGoalsScored: homeStats?.goalsScored ?? 0,
        awayGoalsScored: awayStats?.goalsScored ?? 0,
        homeGoalsConceded: homeStats?.goalsConceded ?? 0,
        awayGoalsConceded: awayStats?.goalsConceded ?? 0,
        fixtureKey: fx.id ?? `${leagueId}:${gameweekId}:${fx.playoffSlot ?? 0}`,
      });

      winners.push(resolution.winnerMemberId);
    }

    if (winners.length === 1) {
      return {
        championMemberId: winners[0],
        settledCount: ordered.length,
      };
    }

    const nextRound = (ordered[0].playoffRound ?? 1) + 1;
    const nextGameweekId = gameweekId + 1;
    const pairings: Array<{ homeMemberId: string; awayMemberId: string }> = [];

    for (let i = 0; i < winners.length; i += 2) {
      pairings.push({
        homeMemberId: winners[i],
        awayMemberId: winners[i + 1],
      });
    }

    await this.db.$transaction(async (tx: any) => {
      await tx.leagueFixture.deleteMany({
        where: { leagueId, gameweekId: nextGameweekId, isFinished: false },
      });
      await tx.leagueFixture.createMany({
        data: pairings.map((p, slot) => ({
          leagueId,
          gameweekId: nextGameweekId,
          homeMemberId: p.homeMemberId,
          awayMemberId: p.awayMemberId,
          isPlayoff: true,
          playoffRound: nextRound,
          playoffSlot: slot,
        })),
      });
    });

    return {
      nextGameweekId,
      nextRound,
      pairings,
    };
  }
}

export const tournamentBracketService = new TournamentBracketService();
