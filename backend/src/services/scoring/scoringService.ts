import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { ChipType, Position, SQUAD_RULES } from "../../types/index.js";

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

  /**
   * Calculates and persists a squad's score for a specific gameweek into the database.
   */
  public async calculateAndPersistSquadScore(
    squadId: string,
    gameweekId: number
  ): Promise<GameweekCalculationResult> {
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
      throw new Error(`Squad ${squadId} not found`);
    }

    // Fetch stats for all players in the squad for this gameweek
    const playerIds = squad.players.map((p) => p.playerId);
    const statsList = await this.db.playerGameweekStats.findMany({
      where: {
        gameweekId,
        playerId: { in: playerIds },
      },
    });

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    for (const st of statsList) {
      statsMap.set(st.playerId, {
        minutes: st.minutes,
        totalPoints: st.totalPoints,
      });
    }

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
    const chip = chipUsage?.chipType ?? null;

    const result = ScoringService.calculateLineupScore(formattedPlayers, statsMap, {
      chip,
      transferCost: existingScore?.transferCost ?? 0,
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
