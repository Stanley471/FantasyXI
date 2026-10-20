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
  /**
   * All 8 valid FPL outfield formations (with 1 GKP):
   * 3-5-2, 3-4-3, 4-4-2, 4-3-3, 5-3-2, 5-4-1, 4-5-1, 5-2-3
   */
  public static readonly VALID_FORMATIONS: ReadonlyArray<
    Readonly<{ def: number; mid: number; fwd: number }>
  > = [
    { def: 3, mid: 5, fwd: 2 },
    { def: 3, mid: 4, fwd: 3 },
    { def: 4, mid: 4, fwd: 2 },
    { def: 4, mid: 3, fwd: 3 },
    { def: 5, mid: 3, fwd: 2 },
    { def: 5, mid: 4, fwd: 1 },
    { def: 4, mid: 5, fwd: 1 },
    { def: 5, mid: 2, fwd: 3 },
  ];

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
   * Returns true when `counts` satisfies FPL minimum/maximum formation rules
   * and matches one of the 8 valid formations (`3-5-2`, `3-4-3`, `4-4-2`,
   * `4-3-3`, `5-3-2`, `5-4-1`, `4-5-1`, `5-2-3`).
   */
  public static isFormationValid(counts: FormationCounts): boolean {
    const min = SQUAD_RULES.MIN_STARTERS;
    const max = SQUAD_RULES.POSITION_COUNTS;
    if (
      counts.gkp < min.GKP ||
      counts.gkp > 1 ||
      counts.def < min.DEF ||
      counts.def > max.DEF ||
      counts.mid < min.MID ||
      counts.mid > max.MID ||
      counts.fwd < min.FWD ||
      counts.fwd > max.FWD
    ) {
      return false;
    }

    const outfieldTotal = counts.def + counts.mid + counts.fwd;
    if (outfieldTotal === 10) {
      return AutoSubstitutionEngine.VALID_FORMATIONS.some(
        (f) => f.def === counts.def && f.mid === counts.mid && f.fwd === counts.fwd
      );
    }

    return true;
  }

  /**
   * Returns true when replacing `starter` with `candidate` keeps the formation
   * within the platform's valid starting formation requirements.
   */
  public static swapKeepsFormationValid(
    starter: PlayerScoreDetail,
    candidate: PlayerScoreDetail,
    counts: FormationCounts
  ): boolean {
    if (
      (starter.position === Position.GKP && candidate.position !== Position.GKP) ||
      (starter.position !== Position.GKP && candidate.position === Position.GKP)
    ) {
      return false;
    }

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

    return AutoSubstitutionEngine.isFormationValid(next);
  }

  /**
   * Generates all size-`k` combinations of `items` in lexicographical index order.
   */
  private static combinations<T>(items: T[], k: number): T[][] {
    if (k === 0) return [[]];
    if (k > items.length) return [];
    const results: T[][] = [];

    const backtrack = (start: number, current: T[]) => {
      if (current.length === k) {
        results.push([...current]);
        return;
      }
      const remainingNeeded = k - current.length;
      for (let i = start; i <= items.length - remainingNeeded; i++) {
        current.push(items[i]);
        backtrack(i + 1, current);
        current.pop();
      }
    };

    backtrack(0, []);
    return results;
  }

  /**
   * Resolves automatic bench substitutions for non-playing starters using a
   * constraint-satisfaction solver.
   *
   * Evaluates all valid combinations of bench players (respecting bench priority
   * order `positionOrder` as primary tie-breaker) that can replace the set of
   * 0-minute starters while guaranteeing the final 11 players adhere to valid
   * FPL formations (`3-5-2`, `3-4-3`, `4-4-2`, `4-3-3`, `5-3-2`, `5-4-1`,
   * `4-5-1`, `5-2-3`). Goalkeeper substitutions remain strictly GKP-for-GKP.
   *
   * Mutates the `subbedIn` / `subbedOut` flags on the supplied details and
   * returns the final starting XI (original starters with replacements).
   */
  public static resolveAutoSubstitutions(
    starterDetails: PlayerScoreDetail[],
    benchDetails: PlayerScoreDetail[]
  ): PlayerScoreDetail[] {
    const currentStarters = [...starterDetails];
    const orderedBench = [...benchDetails].sort(
      (a, b) => a.positionOrder - b.positionOrder
    );

    // 1. Goalkeeper resolution: strictly isolated to GKP-for-GKP
    for (let i = 0; i < currentStarters.length; i++) {
      const starter = currentStarters[i];
      if (starter.position === Position.GKP && starter.minutesPlayed === 0) {
        const benchGkp = orderedBench.find(
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
      }
    }

    // 2. Outfield constraint-satisfaction solver
    const missingOutfieldIndices: number[] = [];
    const playingOutfieldStarters: PlayerScoreDetail[] = [];
    const activeGkps: PlayerScoreDetail[] = [];

    for (let i = 0; i < currentStarters.length; i++) {
      const p = currentStarters[i];
      if (p.position === Position.GKP) {
        activeGkps.push(p);
      } else if (p.minutesPlayed === 0) {
        missingOutfieldIndices.push(i);
      } else {
        playingOutfieldStarters.push(p);
      }
    }

    // Order missing outfield starter indices by starter positionOrder ascending
    missingOutfieldIndices.sort(
      (ia, ib) => currentStarters[ia].positionOrder - currentStarters[ib].positionOrder
    );

    const eligibleOutfieldBench = orderedBench.filter(
      (b) => b.position !== Position.GKP && !b.subbedIn && b.minutesPlayed > 0
    );

    const maxSubs = Math.min(missingOutfieldIndices.length, eligibleOutfieldBench.length);

    let solvedBench: PlayerScoreDetail[] = [];
    let solvedStarterIndices: number[] = [];

    outer: for (let k = maxSubs; k >= 1; k--) {
      const benchCombos = AutoSubstitutionEngine.combinations(eligibleOutfieldBench, k);
      const starterIdxCombos = AutoSubstitutionEngine.combinations(missingOutfieldIndices, k);

      for (const selectedBench of benchCombos) {
        for (const replacedIndices of starterIdxCombos) {
          const replacedIndexSet = new Set(replacedIndices);
          const unreplacedMissingStarters = missingOutfieldIndices
            .filter((idx) => !replacedIndexSet.has(idx))
            .map((idx) => currentStarters[idx]);

          const candidateEleven = [
            ...activeGkps,
            ...playingOutfieldStarters,
            ...unreplacedMissingStarters,
            ...selectedBench,
          ];

          const counts = AutoSubstitutionEngine.countFormation(candidateEleven);
          if (AutoSubstitutionEngine.isFormationValid(counts)) {
            solvedBench = selectedBench;
            solvedStarterIndices = replacedIndices;
            break outer;
          }
        }
      }
    }

    for (let j = 0; j < solvedBench.length; j++) {
      const starterIndex = solvedStarterIndices[j];
      const starter = currentStarters[starterIndex];
      const candidate = solvedBench[j];

      starter.subbedOut = true;
      candidate.subbedIn = true;
      currentStarters[starterIndex] = candidate;
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
      const existing = statsMap.get(st.playerId);
      if (existing) {
        existing.minutes += st.minutes;
        existing.totalPoints += st.totalPoints;
      } else {
        statsMap.set(st.playerId, {
          minutes: st.minutes,
          totalPoints: st.totalPoints,
        });
      }
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
