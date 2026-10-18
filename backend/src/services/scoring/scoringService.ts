import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { ChipType, LeagueStatus, MembershipStatus, Position, SQUAD_RULES } from "../../types/index.js";
import { CompiledScoringRules, ScoringEventStats, compileScoringRules } from "./scoringRuleEngine.js";

/**
 * Scoring and Fantasy Points Calculation Service.
 *
 * Implements:
 * - Starting XI points calculation from PlayerGameweekStats
 * - Captain 2x multiplier (with vice-captain fallback when captain played 0 mins)
 * - Automatic bench substitutions preserving valid formations
 * - Chips: Triple Captain (3x), Bench Boost (bench counts, no auto-subs),
 *   Wildcard / Free Hit (transfer point deductions waived)
 * - Head-to-head match resolution (Win 3 / Draw 1 / Loss 0)
 * - SquadGameweekScore persistence and total points aggregation
 * - Custom per-league scoring rules (issue #272): leagues with a scoringConfig
 *   get a LeagueSquadGameweekScore computed from raw match events with the
 *   league's compiled rules; all other leagues use official FPL points.
 *
 * Laravel equivalent: Like app/Services/ScoringService.php with event listeners
 * calculating gameweek results.
 */

export interface PlayerScoreDetail {
  playerId: number;
  position: Position;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number;
  minutesPlayed: number;
  rawPoints: number;
  multiplier: number; // 1, 2 for active captain, 3 with Triple Captain
  effectivePoints: number; // rawPoints * multiplier
  subbedIn: boolean;
  subbedOut: boolean;
}

export interface LineupScoreOptions {
  chip?: ChipType | null;
  /** Transfer point deduction for the gameweek (e.g. 4 per extra transfer) */
  transferCost?: number;
}

/** One PlayerGameweekStats row: a player's events in one fixture. */
export interface PlayerFixtureStats extends ScoringEventStats {
  playerId: number;
  totalPoints: number;
}

interface SquadScoringInputs {
  players: Array<{
    playerId: number;
    position: Position;
    isStarter: boolean;
    isCaptain: boolean;
    isViceCaptain: boolean;
    positionOrder: number;
  }>;
  stats: PlayerFixtureStats[];
  chip: ChipType | null;
  transferCost: number;
}

export interface CustomLeagueScoringResult {
  leaguesScored: number;
  scoresWritten: number;
}

export interface GameweekCalculationResult {
  squadId: string;
  gameweekId: number;
  startingPoints: number;
  benchPoints: number;
  captainPoints: number;
  transferCost: number;
  chip: ChipType | null;
  totalPoints: number;
  lineupDetails: PlayerScoreDetail[];
}

/** Live per-position counts of the current starting XI. */
export interface FormationCounts {
  gkp: number;
  def: number;
  mid: number;
  fwd: number;
}

/**
 * Dynamic Auto-Substitution Engine.
 *
 * Applies FPL bench rules while guaranteeing that every individual swap keeps
 * the resulting formation valid (>= 1 GKP, >= 3 DEF, >= 2 MID, >= 1 FWD).
 *
 * Rules enforced:
 * - A non-playing starter (0 minutes) may be replaced.
 * - The bench is evaluated in bench priority order (positionOrder ascending).
 * - A bench player is skipped when bringing them on would invalidate the
 *   formation, and the algorithm moves to the next eligible bench player.
 * - A goalkeeper can only be replaced by the bench goalkeeper.
 * - A bench player who played 0 minutes can never be subbed in.
 * - A bench player who was already subbed in is no longer eligible.
 * - Position counts are recomputed live so chained swaps stay formation-safe.
 */
export class AutoSubstitutionEngine {
  public static countFormation(players: PlayerScoreDetail[]): FormationCounts {
    const counts: FormationCounts = { gkp: 0, def: 0, mid: 0, fwd: 0 };
    for (const p of players) {
      switch (p.position) {
        case Position.GKP:
          counts.gkp++;
          break;
        case Position.DEF:
          counts.def++;
          break;
        case Position.MID:
          counts.mid++;
          break;
        case Position.FWD:
          counts.fwd++;
          break;
      }
    }
    return counts;
  }

  /**
   * Returns true when replacing `starter` with `candidate` keeps the formation
   * within the platform's minimum starting requirements.
   */
  public static swapKeepsFormationValid(
    starter: PlayerScoreDetail,
    candidate: PlayerScoreDetail,
    counts: FormationCounts
  ): boolean {
    const next: FormationCounts = {
      gkp:
        counts.gkp -
        (starter.position === Position.GKP ? 1 : 0) +
        (candidate.position === Position.GKP ? 1 : 0),
      def:
        counts.def -
        (starter.position === Position.DEF ? 1 : 0) +
        (candidate.position === Position.DEF ? 1 : 0),
      mid:
        counts.mid -
        (starter.position === Position.MID ? 1 : 0) +
        (candidate.position === Position.MID ? 1 : 0),
      fwd:
        counts.fwd -
        (starter.position === Position.FWD ? 1 : 0) +
        (candidate.position === Position.FWD ? 1 : 0),
    };

    return (
      next.gkp >= SQUAD_RULES.MIN_STARTERS.GKP &&
      next.def >= SQUAD_RULES.MIN_STARTERS.DEF &&
      next.mid >= SQUAD_RULES.MIN_STARTERS.MID &&
      next.fwd >= SQUAD_RULES.MIN_STARTERS.FWD
    );
  }

  /**
   * Resolves automatic bench substitutions for non-playing starters.
   *
   * Mutates the `subbedIn` / `subbedOut` flags on the supplied details and
   * returns the final starting XI (original starters with replacements).
   */
  public static resolveAutoSubstitutions(
    starterDetails: PlayerScoreDetail[],
    benchDetails: PlayerScoreDetail[]
  ): PlayerScoreDetail[] {
    const currentStarters = [...starterDetails];

    for (let i = 0; i < currentStarters.length; i++) {
      const starter = currentStarters[i];
      if (starter.minutesPlayed > 0) {
        continue;
      }

      const counts = AutoSubstitutionEngine.countFormation(currentStarters);

      // Goalkeepers can ONLY be replaced by the bench goalkeeper
      if (starter.position === Position.GKP) {
        const benchGkp = benchDetails.find(
          (b) =>
            b.position === Position.GKP &&
            !b.subbedIn &&
            b.minutesPlayed > 0
        );
        if (benchGkp) {
          starter.subbedOut = true;
          benchGkp.subbedIn = true;
          currentStarters[i] = benchGkp;
        }
        continue;
      }

      // Outfield player (DEF, MID, FWD): walk the bench in priority order and
      // pick the first candidate whose swap keeps the formation valid.
      for (const candidate of benchDetails) {
        if (
          candidate.position === Position.GKP ||
          candidate.subbedIn ||
          candidate.minutesPlayed === 0
        ) {
          continue;
        }

        if (
          AutoSubstitutionEngine.swapKeepsFormationValid(
            starter,
            candidate,
            counts
          )
        ) {
          // Valid substitution found — apply and move on.
          starter.subbedOut = true;
          candidate.subbedIn = true;
          currentStarters[i] = candidate;
          break;
        }
      }
    }

    return currentStarters;
  }
}

export class ScoringService {
  /** The database client is injectable so scoring can be exercised against in-memory fakes. */
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Aggregates per-fixture stats into the per-player map consumed by
   * `calculateLineupScore` (double gameweeks sum across fixtures).
   *
   * Without `rules` this is the official path: FPL's own totalPoints are summed
   * exactly as before, with no extra work. With `rules`, each fixture is
   * re-scored from its raw events using the league's compiled rules.
   */
  public static buildStatsMap(
    stats: PlayerFixtureStats[],
    positions?: Map<number, Position>,
    rules?: CompiledScoringRules | null
  ): Map<number, { minutes: number; totalPoints: number }> {
    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    for (const st of stats) {
      let points = st.totalPoints;
      if (rules) {
        const position = positions?.get(st.playerId);
        points = position ? rules.score(st, position) : 0;
      }
      const existing = statsMap.get(st.playerId);
      if (existing) {
        existing.minutes += st.minutes;
        existing.totalPoints += points;
      } else {
        statsMap.set(st.playerId, { minutes: st.minutes, totalPoints: points });
      }
    }
    return statsMap;
  }

  /**
   * Pure function to calculate gameweek score for a squad given players and their stats.
   * Enables complete automated unit testing without requiring database mocks.
   */
  public static calculateLineupScore(
    players: Array<{
      playerId: number;
      position: Position;
      isStarter: boolean;
      isCaptain: boolean;
      isViceCaptain: boolean;
      positionOrder: number; // 1 to 15 (1-11 starters, 12 bench GKP, 13-15 bench outfield)
    }>,
    statsMap: Map<number, { minutes: number; totalPoints: number }>,
    options: LineupScoreOptions = {}
  ): {
    startingPoints: number;
    benchPoints: number;
    captainPoints: number;
    transferCost: number;
    totalPoints: number;
    details: PlayerScoreDetail[];
  } {
    const chip = options.chip ?? null;
    const isBenchBoost = chip === ChipType.BENCH_BOOST;

    // 1. Separate starters and bench
    const starterDetails: PlayerScoreDetail[] = [];
    const benchDetails: PlayerScoreDetail[] = [];

    for (const p of players) {
      const stats = statsMap.get(p.playerId) || { minutes: 0, totalPoints: 0 };
      const detail: PlayerScoreDetail = {
        playerId: p.playerId,
        position: p.position,
        isStarter: p.isStarter,
        isCaptain: p.isCaptain,
        isViceCaptain: p.isViceCaptain,
        positionOrder: p.positionOrder,
        minutesPlayed: stats.minutes,
        rawPoints: stats.totalPoints,
        multiplier: 1,
        effectivePoints: stats.totalPoints,
        subbedIn: false,
        subbedOut: false,
      };

      if (p.isStarter) {
        starterDetails.push(detail);
      } else {
        benchDetails.push(detail);
      }
    }

    // Sort bench by positionOrder ascending (standard bench priority), and starters
    // too so auto-subs resolve in pitch order whatever order the caller supplied
    starterDetails.sort((a, b) => a.positionOrder - b.positionOrder);
    benchDetails.sort((a, b) => a.positionOrder - b.positionOrder);

    // 2. Perform auto-substitutions for starters who played 0 minutes
    // (skipped with Bench Boost, where every bench player already scores)
    let currentStarters: PlayerScoreDetail[] = [...starterDetails];

    if (!isBenchBoost) {
      currentStarters = AutoSubstitutionEngine.resolveAutoSubstitutions(
        starterDetails,
        benchDetails
      );
    }

    // 3. Determine Captain multiplier (2x, or 3x with Triple Captain)
    // Find designated captain and vice-captain
    const designatedCaptain = starterDetails.find((s) => s.isCaptain);
    const designatedVice = starterDetails.find((s) => s.isViceCaptain);

    let activeCaptain: PlayerScoreDetail | undefined;

    if (designatedCaptain && designatedCaptain.minutesPlayed > 0) {
      activeCaptain = designatedCaptain;
    } else if (designatedVice && designatedVice.minutesPlayed > 0) {
      // Vice-captain steps in as captain
      activeCaptain = designatedVice;
    } else if (designatedCaptain) {
      // Captain played 0 mins and vice played 0 mins, captain keeps 2x of 0
      activeCaptain = designatedCaptain;
    }

    const captainMultiplier = chip === ChipType.TRIPLE_CAPTAIN ? 3 : 2;
    if (activeCaptain) {
      activeCaptain.multiplier = captainMultiplier;
      activeCaptain.effectivePoints = activeCaptain.rawPoints * captainMultiplier;
    }

    // 4. Sum up points
    // Starting XI points (including active subs)
    let startingPoints = 0;
    let captainBonusPoints = 0;

    for (const player of currentStarters) {
      startingPoints += player.effectivePoints;
      if (player.multiplier > 1) {
        // The extra points from captaincy
        captainBonusPoints = player.rawPoints * (player.multiplier - 1);
      }
    }

    // Remaining bench points (players not subbed in)
    let benchPoints = 0;
    for (const b of benchDetails) {
      if (!b.subbedIn) {
        benchPoints += b.rawPoints;
      }
    }

    const allDetails = [...starterDetails, ...benchDetails].sort(
      (a, b) => a.positionOrder - b.positionOrder
    );

    // Wildcard and Free Hit waive transfer point deductions
    const transferCost =
      chip === ChipType.WILDCARD || chip === ChipType.FREE_HIT
        ? 0
        : options.transferCost ?? 0;

    return {
      startingPoints,
      benchPoints,
      captainPoints: captainBonusPoints,
      transferCost,
      totalPoints:
        startingPoints + (isBenchBoost ? benchPoints : 0) - transferCost,
      details: allDetails,
    };
  }

  /**
   * Resolves a head-to-head match: Win = 3 pts, Draw = 1 pt, Loss = 0 pts.
   */
  public static resolveHeadToHead(
    homeScore: number,
    awayScore: number
  ): { homePoints: number; awayPoints: number } {
    if (homeScore > awayScore) return { homePoints: 3, awayPoints: 0 };
    if (homeScore < awayScore) return { homePoints: 0, awayPoints: 3 };
    return { homePoints: 1, awayPoints: 1 };
  }

  /** Loads everything needed to score one squad's gameweek, or null if the squad is gone. */
  private async loadSquadScoringInputs(
    squadId: string,
    gameweekId: number
  ): Promise<SquadScoringInputs | null> {
    const squad = await this.db.squad.findUnique({
      where: { id: squadId },
      include: {
        players: {
          include: { player: true },
          orderBy: { positionOrder: "asc" },
        },
      },
    });

    if (!squad) {
      return null;
    }

    // Fetch stats for all players in the squad for this gameweek
    const playerIds = squad.players.map((p) => p.playerId);
    const statsList = await this.db.playerGameweekStats.findMany({
      where: {
        gameweekId,
        playerId: { in: playerIds },
      },
    });

    const formattedPlayers = squad.players.map((sp) => ({
      playerId: sp.playerId,
      position: sp.player.position,
      isStarter: sp.isStarter,
      isCaptain: sp.isCaptain,
      isViceCaptain: sp.isViceCaptain,
      positionOrder: sp.positionOrder,
    }));

    const [chipUsage, existingScore] = await Promise.all([
      this.db.squadChipUsage.findUnique({
        where: { squadId_gameweekId: { squadId, gameweekId } },
      }),
      this.db.squadGameweekScore.findUnique({
        where: { squadId_gameweekId: { squadId, gameweekId } },
      }),
    ]);

    return {
      players: formattedPlayers,
      stats: statsList,
      chip: chipUsage?.chipType ?? null,
      transferCost: existingScore?.transferCost ?? 0,
    };
  }

  /**
   * Calculates and persists a squad's score for a specific gameweek into the database.
   */
  public async calculateAndPersistSquadScore(
    squadId: string,
    gameweekId: number
  ): Promise<GameweekCalculationResult> {
    const inputs = await this.loadSquadScoringInputs(squadId, gameweekId);
    if (!inputs) {
      throw new Error(`Squad ${squadId} not found`);
    }
    const { chip } = inputs;

    const statsMap = ScoringService.buildStatsMap(inputs.stats);
    const result = ScoringService.calculateLineupScore(inputs.players, statsMap, {
      chip,
      transferCost: inputs.transferCost,
    });

    // Persist into SquadGameweekScore
    await this.db.squadGameweekScore.upsert({
      where: {
        squadId_gameweekId: {
          squadId,
          gameweekId,
        },
      },
      update: {
        points: result.totalPoints,
        benchPoints: result.benchPoints,
        captainPoints: result.captainPoints,
        transferCost: result.transferCost,
        calculatedAt: new Date(),
      },
      create: {
        squadId,
        gameweekId,
        points: result.totalPoints,
        benchPoints: result.benchPoints,
        captainPoints: result.captainPoints,
        transferCost: result.transferCost,
      },
    });

    // Recalculate and update Squad.totalPoints
    const allScores = await this.db.squadGameweekScore.findMany({
      where: { squadId },
      select: { points: true },
    });
    const newTotalPoints = allScores.reduce((sum, s) => sum + s.points, 0);

    await this.db.squad.update({
      where: { id: squadId },
      data: { totalPoints: newTotalPoints },
    });

    return {
      squadId,
      gameweekId,
      startingPoints: result.startingPoints,
      benchPoints: result.benchPoints,
      captainPoints: result.captainPoints,
      transferCost: result.transferCost,
      chip,
      totalPoints: result.totalPoints,
      lineupDetails: result.details,
    };
  }

  /**
   * Scores every active league with custom rules for `gameweekId` (issue #272)
   * and persists one LeagueSquadGameweekScore per member squad.
   *
   * Each squad's lineup and stats are loaded once and evaluated under every
   * custom rule set it is entered with, so a squad in several custom leagues
   * costs one set of queries. Captaincy, auto-subs, chips and transfer costs
   * apply exactly as in official scoring; only per-player points differ.
   * Leagues without a scoringConfig are skipped (they use SquadGameweekScore).
   */
  public async calculateCustomLeagueScores(gameweekId: number): Promise<CustomLeagueScoringResult> {
    const leagues = await this.db.league.findMany({
      where: {
        status: LeagueStatus.ACTIVE,
        startGameweekId: { lte: gameweekId },
        endGameweekId: { gte: gameweekId },
      },
      select: {
        id: true,
        scoringConfig: true,
        members: { where: { status: MembershipStatus.ACTIVE }, select: { squadId: true } },
      },
    });

    // squadId -> leagues (with compiled rules) that squad must be scored for
    const leaguesBySquad = new Map<string, Array<{ leagueId: string; rules: CompiledScoringRules }>>();
    let leaguesScored = 0;
    for (const league of leagues) {
      if (league.scoringConfig === null || league.scoringConfig === undefined) continue;
      let rules: CompiledScoringRules;
      try {
        rules = compileScoringRules(league.scoringConfig);
      } catch (error) {
        console.error(`[scoring] League ${league.id} has invalid custom scoring rules; skipped:`, error);
        continue;
      }
      leaguesScored++;
      for (const member of league.members) {
        const entries = leaguesBySquad.get(member.squadId) ?? [];
        entries.push({ leagueId: league.id, rules });
        leaguesBySquad.set(member.squadId, entries);
      }
    }

    let scoresWritten = 0;
    for (const [squadId, entries] of leaguesBySquad) {
      const inputs = await this.loadSquadScoringInputs(squadId, gameweekId);
      if (!inputs) continue;
      const positions = new Map(inputs.players.map((p) => [p.playerId, p.position]));

      for (const { leagueId, rules } of entries) {
        const statsMap = ScoringService.buildStatsMap(inputs.stats, positions, rules);
        const result = ScoringService.calculateLineupScore(inputs.players, statsMap, {
          chip: inputs.chip,
          transferCost: inputs.transferCost,
        });
        await this.db.leagueSquadGameweekScore.upsert({
          where: { leagueId_squadId_gameweekId: { leagueId, squadId, gameweekId } },
          update: { points: result.totalPoints, calculatedAt: new Date() },
          create: { leagueId, squadId, gameweekId, points: result.totalPoints },
        });
        scoresWritten++;
      }
    }

    return { leaguesScored, scoresWritten };
  }

  /**
   * Calculates total points for a squad across a range of gameweeks.
   */
  public async getSquadScoreAcrossGameweeks(
    squadId: string,
    startGameweekId?: number,
    endGameweekId?: number
  ): Promise<number> {
    const whereClause: {
      squadId: string;
      gameweekId?: { gte?: number; lte?: number };
    } = { squadId };

    if (startGameweekId !== undefined || endGameweekId !== undefined) {
      whereClause.gameweekId = {};
      if (startGameweekId !== undefined) whereClause.gameweekId.gte = startGameweekId;
      if (endGameweekId !== undefined) whereClause.gameweekId.lte = endGameweekId;
    }

    const scores = await this.db.squadGameweekScore.findMany({
      where: whereClause,
      select: { points: true },
    });

    return scores.reduce((sum, s) => sum + s.points, 0);
  }
}

export const scoringService = new ScoringService();
