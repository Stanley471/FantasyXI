/**
 * Squad Similarity Analyzer (Issue #519)
 * Detects coordinated syndicates via Jaccard similarity and shared signals
 */

import { logger } from "../../../../config/logger.js";
import { prisma } from "../../../../config/db.js";

export interface SquadSnapshot {
  squadId: string;
  userId: string;
  playerIds: Set<number>;
}

export interface SimilarityPair {
  squadA: SquadSnapshot;
  squadB: SquadSnapshot;
  similarity: number;
  sharedIp?: boolean;
  sharedReferral?: boolean;
}

export class SquadSimilarityAnalyzer {
  private similarityThreshold: number;

  constructor(similarityThreshold: number = 0.9) {
    this.similarityThreshold = similarityThreshold;
  }

  /**
   * Computes Jaccard similarity: |A ∩ B| / |A ∪ B|
   */
  public computeJaccard(setA: Set<number>, setB: Set<number>): number {
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  /**
   * Fetches squads for a league
   */
  public async fetchSquadsForLeague(leagueId: string): Promise<SquadSnapshot[]> {
    try {
      const members = await prisma.leagueMember.findMany({
        where: { leagueId },
        include: {
          squad: {
            include: {
              players: true,
            },
          },
          user: true,
        },
      });

      return members.map((member) => ({
        squadId: member.squadId,
        userId: member.userId,
        playerIds: new Set(member.squad.players.map((sp) => sp.playerId)),
      }));
    } catch (error) {
      logger.error({ error, leagueId }, "Failed to fetch squads");
      throw error;
    }
  }

  /**
   * Computes pairwise similarities
   */
  public computeSimilarities(squads: SquadSnapshot[]): SimilarityPair[] {
    const pairs: SimilarityPair[] = [];

    for (let i = 0; i < squads.length; i++) {
      for (let j = i + 1; j < squads.length; j++) {
        const similarity = this.computeJaccard(
          squads[i].playerIds,
          squads[j].playerIds
        );

        if (similarity > this.similarityThreshold) {
          pairs.push({
            squadA: squads[i],
            squadB: squads[j],
            similarity,
          });
        }
      }
    }

    return pairs;
  }

  /**
   * Checks if two users share registration IP or referral
   */
  public async checkSharedSignals(userId1: string, userId2: string): Promise<string[]> {
    try {
      const [user1, user2] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId1 } }),
        prisma.user.findUnique({ where: { id: userId2 } }),
      ]);

      if (!user1 || !user2) return [];

      const signals: string[] = [];

      // Check referral link
      if (user1.referrerId === user2.id || user2.referrerId === user1.id) {
        signals.push("SHARED_REFERRAL_DIRECT");
      }
      if (user1.referralCode && user1.referralCode === user2.referralCode) {
        signals.push("SHARED_REFERRAL_CODE");
      }

      return signals;
    } catch (error) {
      logger.error({ error }, "Failed to check signals");
      return [];
    }
  }

  /**
   * Analyzes a league for collusion
   */
  public async analyzeLeague(leagueId: string): Promise<SimilarityPair[]> {
    logger.info({ leagueId }, "Starting collusion analysis");

    const squads = await this.fetchSquadsForLeague(leagueId);
    const pairs = this.computeSimilarities(squads);

    for (const pair of pairs) {
      const signals = await this.checkSharedSignals(
        pair.squadA.userId,
        pair.squadB.userId
      );
      pair.sharedIp = signals.includes("SHARED_IP");
      pair.sharedReferral =
        signals.includes("SHARED_REFERRAL_DIRECT") ||
        signals.includes("SHARED_REFERRAL_CODE");
    }

    logger.info({ leagueId, pairsDetected: pairs.length }, "Analysis complete");
    return pairs;
  }
}

export const squadSimilarityAnalyzer = new SquadSimilarityAnalyzer(0.9);
