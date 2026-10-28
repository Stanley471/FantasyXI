import { PrismaClient, LeagueCollusionFlag, LeagueMember, Squad, SquadTransfer, Player, League, Gameweek } from '@prisma/client';
import { logger } from '@/config/logger';
import { 
  computeTransferSimilarity, 
  TransferSimilarityConfig, 
  DEFAULT_TRANSFER_SIMILARITY_CONFIG 
} from './transferSimilaritySignal';
import { 
  computeSharedIpScore, 
  SharedIpConfig, 
  DEFAULT_SHARED_IP_CONFIG 
} from './sharedIpSignal';
import { 
  computeChipTimingScore, 
  ChipTimingConfig, 
  DEFAULT_CHIP_TIMING_CONFIG 
} from './chipTimingSignal';
import { 
  computeBenchGhostingScore, 
  BenchGhostingConfig, 
  DEFAULT_BENCH_GHOSTING_CONFIG,
  SquadLineup 
} from './benchGhostingSignal';
import { 
  computePointAbsorptionScore, 
  PointAbsorptionConfig, 
  DEFAULT_POINT_ABSORPTION_CONFIG 
} from './pointAbsorptionSignal';

/**
 * Risk scoring configuration combining all signals with weights.
 */
export interface RiskScoringConfig {
  transferSimilarityWeight: number;
  sharedIpWeight: number;
  chipTimingWeight: number;
  benchGhostingWeight: number;
  pointAbsorptionWeight: number;
  
  // Require at least 2 independent signal families for a flag
  require2IndependentFamilies: boolean;
  minCombinedScore: number; // 0.60 = 60%
  
  // Suspension requires very high confidence
  suspensionThreshold: number; // 0.85 = 85%
  require3Signals: boolean;
  autoSuspend: boolean; // if true, auto-suspend at threshold; if false, require admin approval
}

/**
 * Default risk scoring configuration.
 */
export const DEFAULT_RISK_SCORING_CONFIG: RiskScoringConfig = {
  transferSimilarityWeight: 0.35,
  sharedIpWeight: 0.15,
  chipTimingWeight: 0.25,
  benchGhostingWeight: 0.15,
  pointAbsorptionWeight: 0.10,
  require2IndependentFamilies: true,
  minCombinedScore: 0.60,
  suspensionThreshold: 0.85,
  require3Signals: true,
  autoSuspend: false, // Require admin approval for suspension
};

/**
 * Signal scores for a pair of accounts.
 */
interface PairSignalScores {
  transferSimilarity: { score: number; triggered: boolean };
  sharedIp: { score: number; triggered: boolean };
  chipTiming: { score: number; triggered: boolean };
  benchGhosting: { score: number; triggered: boolean };
  pointAbsorption: { score: number; triggered: boolean };
}

/**
 * Evidence payload for a flag.
 */
interface CollusionEvidencePayload {
  analysisRanAt: Date;
  configVersion: string;
  leagueId: string;
  gameweekRange: { startGW: number; endGW: number };
  signals: {
    transferSimilarity?: unknown;
    sharedIp?: unknown;
    chipTiming?: unknown;
    benchGhosting?: unknown;
    pointAbsorption?: unknown;
  };
  aggregateScore: number;
  weights: RiskScoringConfig;
  flagThreshold: number;
  suspensionThreshold: number;
  notes?: string;
}

/**
 * Candidate pair for detailed analysis.
 */
interface CandidatePair {
  memberA: LeagueMember & { user: { id: string }; squad: Squad };
  memberB: LeagueMember & { user: { id: string }; squad: Squad };
  reason: string; // Why they were selected as candidates
}

/**
 * Service for detecting and managing league collusion.
 */
export class LeagueIntegrityService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Audit a league for collusion after a gameweek settles.
   * Main orchestrator: bucketing → candidate generation → pairwise scoring → flagging.
   *
   * @param leagueId League to audit
   * @param gameweekId Gameweek that just settled
   * @param options Audit options
   */
  async auditLeagueForCollusion(
    leagueId: string,
    gameweekId: number,
    options: {
      riskConfig?: RiskScoringConfig;
      transferConfig?: TransferSimilarityConfig;
      ipConfig?: SharedIpConfig;
      chipConfig?: ChipTimingConfig;
      benchConfig?: BenchGhostingConfig;
      pointConfig?: PointAbsorptionConfig;
      maxCandidates?: number;
      dryRun?: boolean;
    } = {}
  ): Promise<{ flagsCreated: number; accountsSuspended: number }> {
    const riskConfig = options.riskConfig ?? DEFAULT_RISK_SCORING_CONFIG;
    const configVersion = '1.0'; // Bumped on config changes for reproducibility

    logger.info(`[Collusion Audit] Starting audit for league ${leagueId}, GW ${gameweekId}`);

    try {
      // Fetch league and gameweek context
      const league = await this.prisma.league.findUnique({
        where: { id: leagueId },
        include: { startGameweek: true, endGameweek: true },
      });

      if (!league) {
        logger.warn(`[Collusion Audit] League ${leagueId} not found`);
        return { flagsCreated: 0, accountsSuspended: 0 };
      }

      const gameweekRange = {
        startGW: league.startGameweek.fplId,
        endGW: Math.min(gameweekId, league.endGameweek.fplId),
      };

      // Fetch all members with relations
      const members = await this.prisma.leagueMember.findMany({
        where: {
          leagueId,
          status: 'ACTIVE',
        },
        include: {
          user: true,
          squad: true,
        },
      });

      logger.info(`[Collusion Audit] Fetched ${members.length} active members`);

      if (members.length < 3) {
        logger.info(`[Collusion Audit] League too small (${members.length} members), skipping`);
        return { flagsCreated: 0, accountsSuspended: 0 };
      }

      // Phase 1: Bucketing (reduce O(n²) to manageable candidates)
      const candidates = await this.generateCandidatePairs(
        members,
        leagueId,
        gameweekRange,
        options.maxCandidates ?? 500
      );

      logger.info(`[Collusion Audit] Generated ${candidates.length} candidate pairs for detailed analysis`);

      if (candidates.length === 0) {
        logger.info(`[Collusion Audit] No suspicious candidate pairs found`);
        return { flagsCreated: 0, accountsSuspended: 0 };
      }

      // Phase 2: Pairwise scoring (compute all signals)
      const scoredPairs = await this.scoreCandidatePairs(
        candidates,
        leagueId,
        gameweekRange,
        {
          riskConfig,
          configVersion,
          ...options,
        }
      );

      logger.info(`[Collusion Audit] Scored ${scoredPairs.length} pairs`);

      // Phase 3: Flagging and suspension
      let flagsCreated = 0;
      let accountsSuspended = 0;

      for (const pair of scoredPairs) {
        if (pair.riskScore >= riskConfig.minCombinedScore) {
          if (!options.dryRun) {
            const { flagCreated, suspended } = await this.createOrUpdateFlag(
              pair,
              leagueId,
              riskConfig,
              configVersion
            );

            if (flagCreated) flagsCreated++;
            if (suspended) accountsSuspended++;
          } else {
            if (pair.riskScore >= riskConfig.minCombinedScore) flagsCreated++;
            if (pair.riskScore >= riskConfig.suspensionThreshold) accountsSuspended++;
          }
        }
      }

      logger.info(`[Collusion Audit] Completed: ${flagsCreated} flags, ${accountsSuspended} suspensions`);

      return { flagsCreated, accountsSuspended };
    } catch (error) {
      logger.error(`[Collusion Audit] Error auditing league ${leagueId}:`, error);
      throw error;
    }
  }

  /**
   * Generate candidate pairs using bucketing (shared IP, rare transfers).
   * Avoids O(n²) pairwise comparison of all members.
   */
  private async generateCandidatePairs(
    members: Array<LeagueMember & { user: any; squad: Squad }>,
    leagueId: string,
    gameweekRange: { startGW: number; endGW: number },
    maxCandidates: number
  ): Promise<CandidatePair[]> {
    const candidates: CandidatePair[] = [];
    const seen = new Set<string>();

    // Bucket 1: Members sharing IP subnets
    const userIds = members.map((m) => m.user.id);
    const accountSignals = await this.prisma.accountSignal.findMany({
      where: {
        userId: { in: userIds },
        type: 'IP_SUBNET',
      },
    });

    const subnetToUsers = new Map<string, string[]>();
    for (const signal of accountSignals) {
      if (!subnetToUsers.has(signal.value)) {
        subnetToUsers.set(signal.value, []);
      }
      subnetToUsers.get(signal.value)!.push(signal.userId);
    }

    for (const [_subnet, userIds] of subnetToUsers.entries()) {
      if (userIds.length < 2) continue;

      // Find members with these user IDs
      const bucketed = members.filter((m) => userIds.includes(m.user.id));

      // Pair all combinations
      for (let i = 0; i < bucketed.length; i++) {
        for (let j = i + 1; j < bucketed.length; j++) {
          const pairKey = [bucketed[i].user.id, bucketed[j].user.id].sort().join(':');
          if (!seen.has(pairKey)) {
            seen.add(pairKey);
            candidates.push({
              memberA: bucketed[i],
              memberB: bucketed[j],
              reason: 'shared_ip',
            });
          }
        }
      }
    }

    logger.debug(`[Bucketing] Shared IP: ${candidates.length} candidates`);

    // Bucket 2: Members with rare transfer overlaps
    // Fetch all transfers for gameweek range
    const transfers = await this.prisma.squadTransfer.findMany({
      where: {
        gameweekId: { gte: gameweekRange.startGW, lte: gameweekRange.endGW },
        squad: { memberships: { some: { leagueId } } },
      },
      include: { playerIn: true, playerOut: true },
    });

    // Group by squad
    const transfersBySquad = new Map<string, typeof transfers>();
    for (const transfer of transfers) {
      if (!transfersBySquad.has(transfer.squadId)) {
        transfersBySquad.set(transfer.squadId, []);
      }
      transfersBySquad.get(transfer.squadId)!.push(transfer);
    }

    // Identify rare transfer sequences (simple heuristic: exact same (in, out) pair)
    const rareTransferToSquads = new Map<string, string[]>();
    for (const [squadId, trans] of transfersBySquad.entries()) {
      for (const t of trans) {
        const key = `${Math.min(t.playerInId, t.playerOutId)}:${Math.max(t.playerInId, t.playerOutId)}`;
        if (!rareTransferToSquads.has(key)) {
          rareTransferToSquads.set(key, []);
        }
        rareTransferToSquads.get(key)!.push(squadId);
      }
    }

    for (const [_transfer, squadIds] of rareTransferToSquads.entries()) {
      if (squadIds.length < 2) continue;

      // Find members with these squads
      const bucketed = members.filter((m) => squadIds.includes(m.squadId));

      for (let i = 0; i < bucketed.length; i++) {
        for (let j = i + 1; j < bucketed.length; j++) {
          const pairKey = [bucketed[i].user.id, bucketed[j].user.id].sort().join(':');
          if (!seen.has(pairKey)) {
            seen.add(pairKey);
            candidates.push({
              memberA: bucketed[i],
              memberB: bucketed[j],
              reason: 'rare_transfer_overlap',
            });
          }
        }
      }
    }

    logger.debug(`[Bucketing] After rare transfers: ${candidates.length} candidates`);

    // Cap candidates to avoid excessive processing
    if (candidates.length > maxCandidates) {
      candidates.splice(maxCandidates);
      logger.info(`[Bucketing] Capped candidates to ${maxCandidates}`);
    }

    return candidates;
  }

  /**
   * Score each candidate pair across all signals.
   */
  private async scoreCandidatePairs(
    candidates: CandidatePair[],
    leagueId: string,
    gameweekRange: { startGW: number; endGW: number },
    options: {
      riskConfig: RiskScoringConfig;
      configVersion: string;
      transferConfig?: TransferSimilarityConfig;
      ipConfig?: SharedIpConfig;
      chipConfig?: ChipTimingConfig;
      benchConfig?: BenchGhostingConfig;
      pointConfig?: PointAbsorptionConfig;
    }
  ): Promise<
    Array<{
      memberA: LeagueMember & { user: any; squad: Squad };
      memberB: LeagueMember & { user: any; squad: Squad };
      riskScore: number;
      signalsTriggered: string[];
      evidence: CollusionEvidencePayload;
    }>
  > {
    const results = [];

    for (const candidate of candidates) {
      const scores: PairSignalScores = {
        transferSimilarity: { score: 0, triggered: false },
        sharedIp: { score: 0, triggered: false },
        chipTiming: { score: 0, triggered: false },
        benchGhosting: { score: 0, triggered: false },
        pointAbsorption: { score: 0, triggered: false },
      };

      const evidence: Partial<CollusionEvidencePayload> = {
        analysisRanAt: new Date(),
        configVersion: options.configVersion,
        leagueId,
        gameweekRange,
        signals: {},
        weights: options.riskConfig,
      };

      try {
        // Signal 1: Transfer Similarity
        try {
          const allTransfers = await this.prisma.squadTransfer.findMany({
            where: {
              gameweekId: { gte: gameweekRange.startGW, lte: gameweekRange.endGW },
              squad: { memberships: { some: { leagueId } } },
            },
            include: { playerIn: true, playerOut: true },
          });

          const transfersA = allTransfers.filter((t) => t.squadId === candidate.memberA.squadId);
          const transfersB = allTransfers.filter((t) => t.squadId === candidate.memberB.squadId);

          const result = computeTransferSimilarity(
            transfersA,
            transfersB,
            allTransfers,
            gameweekRange,
            options.transferConfig ?? DEFAULT_TRANSFER_SIMILARITY_CONFIG
          );

          scores.transferSimilarity.score = result.score;
          scores.transferSimilarity.triggered = result.score > 0;
          (evidence.signals as any).transferSimilarity = result.evidence;
        } catch (err) {
          logger.error('[Transfer Signal]', err);
        }

        // Signal 2: Shared IP
        try {
          const signalsA = await this.prisma.accountSignal.findMany({
            where: { userId: candidate.memberA.user.id },
          });

          const signalsB = await this.prisma.accountSignal.findMany({
            where: { userId: candidate.memberB.user.id },
          });

          const allSignals = await this.prisma.accountSignal.findMany({
            where: { userId: { in: [candidate.memberA.user.id, candidate.memberB.user.id] } },
          });

          const result = computeSharedIpScore(
            signalsA as any,
            signalsB as any,
            allSignals as any,
            options.ipConfig ?? DEFAULT_SHARED_IP_CONFIG
          );

          scores.sharedIp.score = result.score;
          scores.sharedIp.triggered = result.score > 0;
          (evidence.signals as any).sharedIp = result.evidence;
        } catch (err) {
          logger.error('[IP Signal]', err);
        }

        // Signal 3: Chip Timing
        try {
          const chipsA = await this.prisma.squadChipUsage.findMany({
            where: {
              squadId: candidate.memberA.squadId,
              gameweekId: { gte: gameweekRange.startGW, lte: gameweekRange.endGW },
            },
          });

          const chipsB = await this.prisma.squadChipUsage.findMany({
            where: {
              squadId: candidate.memberB.squadId,
              gameweekId: { gte: gameweekRange.startGW, lte: gameweekRange.endGW },
            },
          });

          const allChips = await this.prisma.squadChipUsage.findMany({
            where: {
              gameweekId: { gte: gameweekRange.startGW, lte: gameweekRange.endGW },
              squad: { memberships: { some: { leagueId } } },
            },
          });

          const league = await this.prisma.league.findUnique({ where: { id: leagueId } });
          const leagueSize = league?.currentMembers ?? 1;

          const result = computeChipTimingScore(
            chipsA as any,
            chipsB as any,
            allChips as any,
            null, // H2H fixtures: null for now, could be fetched separately
            leagueSize,
            gameweekRange,
            options.chipConfig ?? DEFAULT_CHIP_TIMING_CONFIG
          );

          scores.chipTiming.score = result.score;
          scores.chipTiming.triggered = result.score > 0;
          (evidence.signals as any).chipTiming = result.evidence;
        } catch (err) {
          logger.error('[Chip Signal]', err);
        }

        // Signal 4: Bench Ghosting
        try {
          const lineupsA = await this.getSquadLineups(candidate.memberA.squadId, gameweekRange);
          const lineupsB = await this.getSquadLineups(candidate.memberB.squadId, gameweekRange);

          const result = computeBenchGhostingScore(
            lineupsA,
            lineupsB,
            gameweekRange,
            options.benchConfig ?? DEFAULT_BENCH_GHOSTING_CONFIG
          );

          scores.benchGhosting.score = result.score;
          scores.benchGhosting.triggered = result.score > 0;
          (evidence.signals as any).benchGhosting = result.evidence;
        } catch (err) {
          logger.error('[Bench Signal]', err);
        }

        // Signal 5: Point Absorption
        try {
          const scoresA = await this.prisma.squadGameweekScore.findMany({
            where: {
              squadId: candidate.memberA.squadId,
              gameweekId: { gte: gameweekRange.startGW, lte: gameweekRange.endGW },
            },
          });

          const scoresB = await this.prisma.squadGameweekScore.findMany({
            where: {
              squadId: candidate.memberB.squadId,
              gameweekId: { gte: gameweekRange.startGW, lte: gameweekRange.endGW },
            },
          });

          const result = computePointAbsorptionScore(
            scoresA as any,
            scoresB as any,
            gameweekRange,
            options.pointConfig ?? DEFAULT_POINT_ABSORPTION_CONFIG
          );

          scores.pointAbsorption.score = result.score;
          scores.pointAbsorption.triggered = result.score > 0;
          (evidence.signals as any).pointAbsorption = result.evidence;
        } catch (err) {
          logger.error('[Point Absorption Signal]', err);
        }

        // Aggregate scores
        const weights = options.riskConfig;
        const riskScore =
          scores.transferSimilarity.score * weights.transferSimilarityWeight +
          scores.sharedIp.score * weights.sharedIpWeight +
          scores.chipTiming.score * weights.chipTimingWeight +
          scores.benchGhosting.score * weights.benchGhostingWeight +
          scores.pointAbsorption.score * weights.pointAbsorptionWeight;

        // Count triggered signals
        const signalsTriggered = (Object.entries(scores) as any)
          .filter(([_key, value]) => value.triggered)
          .map(([key]) => key.toUpperCase());

        // Apply multi-signal requirements
        let qualifies = true;
        if (weights.require2IndependentFamilies && signalsTriggered.length < 2) {
          qualifies = false;
        }

        if (qualifies && riskScore >= weights.minCombinedScore) {
          results.push({
            memberA: candidate.memberA,
            memberB: candidate.memberB,
            riskScore: Math.min(1.0, riskScore),
            signalsTriggered,
            evidence: {
              ...evidence,
              aggregateScore: Math.min(1.0, riskScore),
              flagThreshold: weights.minCombinedScore,
              suspensionThreshold: weights.suspensionThreshold,
            } as CollusionEvidencePayload,
          });
        }
      } catch (err) {
        logger.error(`[Scoring] Error scoring pair ${candidate.memberA.user.id}/${candidate.memberB.user.id}:`, err);
      }
    }

    return results;
  }

  /**
   * Create or update a collusion flag.
   */
  private async createOrUpdateFlag(
    pair: {
      memberA: LeagueMember & { user: any; squad: Squad };
      memberB: LeagueMember & { user: any; squad: Squad };
      riskScore: number;
      signalsTriggered: string[];
      evidence: CollusionEvidencePayload;
    },
    leagueId: string,
    riskConfig: RiskScoringConfig,
    configVersion: string
  ): Promise<{ flagCreated: boolean; suspended: boolean }> {
    let flagCreated = false;
    let suspended = false;

    try {
      const confidenceLevel =
        pair.riskScore >= riskConfig.suspensionThreshold
          ? 'CRITICAL'
          : pair.riskScore >= 0.75
            ? 'HIGH'
            : pair.riskScore >= 0.60
              ? 'MEDIUM'
              : 'LOW';

      // Upsert flag
      const flag = await this.prisma.leagueCollusionFlag.upsert({
        where: {
          leagueId_accountAId_accountBId: {
            leagueId,
            accountAId: pair.memberA.user.id,
            accountBId: pair.memberB.user.id,
          },
        },
        create: {
          leagueId,
          accountAId: pair.memberA.user.id,
          squadAId: pair.memberA.squadId,
          accountBId: pair.memberB.user.id,
          squadBId: pair.memberB.squadId,
          riskScore: pair.riskScore,
          confidenceLevel,
          signalsTriggered: pair.signalsTriggered,
          evidencePayload: pair.evidence,
          configVersion,
          status: 'FLAGGED',
        },
        update: {
          riskScore: pair.riskScore,
          confidenceLevel,
          signalsTriggered: pair.signalsTriggered,
          evidencePayload: pair.evidence,
          updatedAt: new Date(),
        },
      });

      flagCreated = !flag.suspendedLeagueParticipationAt && pair.riskScore >= riskConfig.minCombinedScore;

      // Auto-suspend if threshold met and policy enabled
      if (riskConfig.autoSuspend && pair.riskScore >= riskConfig.suspensionThreshold && !flag.suspendedLeagueParticipationAt) {
        // Suspend league participation for both accounts
        await this.prisma.leagueCollusionFlag.update({
          where: { id: flag.id },
          data: {
            suspendedLeagueParticipationAt: new Date(),
            suspensionReason: `Auto-suspended due to high-confidence collusion detection (score=${pair.riskScore.toFixed(2)})`,
          },
        });

        // Mark league members as suspended (optional: create a new status or set a flag)
        logger.warn(`[Suspension] Auto-suspended accounts ${pair.memberA.user.id} and ${pair.memberB.user.id} from league ${leagueId}`);
        suspended = true;
      }
    } catch (err) {
      logger.error(`[Flag Creation] Error creating flag:`, err);
    }

    return { flagCreated, suspended };
  }

  /**
   * Get squad lineups for a gameweek range.
   */
  private async getSquadLineups(
    squadId: string,
    gameweekRange: { startGW: number; endGW: number }
  ): Promise<SquadLineup[]> {
    const players = await this.prisma.squadPlayer.findMany({
      where: { squadId },
      include: { player: true },
    });

    // Create a lineup for each gameweek (simplified: use current lineup for all GWs)
    // In practice, you'd fetch historical lineup snapshots if available
    const lineups: SquadLineup[] = [];
    for (let gw = gameweekRange.startGW; gw <= gameweekRange.endGW; gw++) {
      lineups.push({
        gameweekId: gw,
        captainPlayerId: players.find((p) => p.isCaptain)?.playerId ?? 0,
        viceCaptainPlayerId: players.find((p) => p.isViceCaptain)?.playerId ?? 0,
        benchOrder: players
          .filter((p) => !p.isStarter)
          .sort((a, b) => a.positionOrder - b.positionOrder)
          .map((p) => p.playerId),
      });
    }

    return lineups;
  }
}
