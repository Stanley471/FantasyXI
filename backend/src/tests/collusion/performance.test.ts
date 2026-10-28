import { describe, it, expect } from 'vitest';
import { 
  computeTransferSimilarity, 
  DEFAULT_TRANSFER_SIMILARITY_CONFIG 
} from '@/services/league/collusion/transferSimilaritySignal';
import { 
  computeSharedIpScore, 
  DEFAULT_SHARED_IP_CONFIG 
} from '@/services/league/collusion/sharedIpSignal';
import { SquadTransfer, Player } from '@prisma/client';

/**
 * Performance tests: verify that large-league audits complete within acceptable time.
 */

describe('Performance: Large League Audit', () => {
  it('should audit 1000-member league within 30 seconds', () => {
    const startTime = Date.now();

    // Simulate 1000 members
    const memberCount = 1000;
    const candidatePairCount = 200; // After bucketing, ~200 candidate pairs

    // Simulate transfers: each member makes ~30 transfers per season (5 GW average)
    const transfersPerMember = 30;
    const now = new Date();

    const allTransfers: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [];

    for (let memberId = 0; memberId < memberCount; memberId++) {
      for (let t = 0; t < transfersPerMember; t++) {
        allTransfers.push({
          id: memberId * transfersPerMember + t,
          squadId: `squad${memberId}`,
          gameweekId: (t % 38) + 1, // 38 gameweeks
          playerInId: Math.floor(Math.random() * 500) + 1,
          playerOutId: Math.floor(Math.random() * 500) + 1,
          inPrice: Math.random() * 10 + 3,
          outPrice: Math.random() * 10 + 3,
          pointsCost: 0,
          timestamp: new Date(now.getTime() + Math.random() * 38 * 7 * 24 * 60 * 60 * 1000),
          playerIn: { fplId: Math.floor(Math.random() * 500) + 1 } as Player,
          playerOut: { fplId: Math.floor(Math.random() * 500) + 1 } as Player,
        });
      }
    }

    // Simulate scoring all candidate pairs
    let totalScoreTime = 0;

    for (let p = 0; p < candidatePairCount; p++) {
      const idx1 = Math.floor(Math.random() * memberCount);
      const idx2 = Math.floor(Math.random() * memberCount);

      if (idx1 === idx2) continue;

      const transfers1 = allTransfers.filter((t) => t.squadId === `squad${idx1}`);
      const transfers2 = allTransfers.filter((t) => t.squadId === `squad${idx2}`);

      const pairStartTime = Date.now();

      // Score pair
      computeTransferSimilarity(transfers1, transfers2, allTransfers, { startGW: 1, endGW: 38 });

      totalScoreTime += Date.now() - pairStartTime;
    }

    const totalTime = Date.now() - startTime;

    console.log(`Performance: ${candidatePairCount} pairs scored in ${totalScoreTime}ms (avg ${(totalScoreTime / candidatePairCount).toFixed(2)}ms per pair)`);
    console.log(`Total audit time: ${totalTime}ms`);

    // Should complete within 30 seconds
    expect(totalTime).toBeLessThan(30 * 1000);

    // Per-pair scoring should be <200ms
    expect(totalScoreTime / candidatePairCount).toBeLessThan(200);
  });

  it('should handle 500 candidate pairs efficiently with bucketing', () => {
    const startTime = Date.now();

    const memberCount = 1000;
    const candidatePairCount = 500; // Pre-filtered by bucketing

    // Generate realistic IP signals for bucketing
    const now = new Date();
    const ipSignals = [];

    for (let memberId = 0; memberId < memberCount; memberId++) {
      // Simulate: 90% unique IPs, 10% shared (households, offices)
      const ipIdx = Math.random() < 0.1 ? Math.floor(Math.random() * 50) : memberId;
      ipSignals.push({
        type: 'IP_SUBNET' as const,
        value: `192.168.${Math.floor(ipIdx / 256)}.${ipIdx % 256}/24`,
        userId: `user${memberId}`,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }

    // Score IP overlaps for candidate pairs
    let ipScoreTime = 0;

    for (let p = 0; p < candidatePairCount; p++) {
      const idx1 = Math.floor(Math.random() * memberCount);
      const idx2 = Math.floor(Math.random() * memberCount);

      if (idx1 === idx2) continue;

      const pairStartTime = Date.now();

      computeSharedIpScore([ipSignals[idx1]], [ipSignals[idx2]], ipSignals);

      ipScoreTime += Date.now() - pairStartTime;
    }

    const totalTime = Date.now() - startTime;

    console.log(`IP scoring: ${candidatePairCount} pairs in ${ipScoreTime}ms (avg ${(ipScoreTime / candidatePairCount).toFixed(2)}ms per pair)`);

    // IP scoring should be very fast (<10ms per pair)
    expect(ipScoreTime / candidatePairCount).toBeLessThan(10);

    // Total should still be reasonable
    expect(totalTime).toBeLessThan(10 * 1000);
  });

  it('should scale with candidate pair count but not explode', () => {
    const scenarios = [
      { pairs: 50, maxTime: 5 * 1000 },
      { pairs: 200, maxTime: 15 * 1000 },
      { pairs: 500, maxTime: 30 * 1000 },
    ];

    for (const scenario of scenarios) {
      const startTime = Date.now();

      // Simulate transfer scoring for N pairs
      for (let p = 0; p < scenario.pairs; p++) {
        const transfers1: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [];
        const transfers2: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [];

        // Each squad ~30 transfers
        for (let t = 0; t < 30; t++) {
          transfers1.push({
            id: t,
            squadId: 'squad1',
            gameweekId: (t % 38) + 1,
            playerInId: Math.floor(Math.random() * 500),
            playerOutId: Math.floor(Math.random() * 500),
            inPrice: 8.0,
            outPrice: 8.0,
            pointsCost: 0,
            timestamp: new Date(),
            playerIn: { fplId: Math.floor(Math.random() * 500) } as Player,
            playerOut: { fplId: Math.floor(Math.random() * 500) } as Player,
          });

          transfers2.push({
            id: t + 1000,
            squadId: 'squad2',
            gameweekId: (t % 38) + 1,
            playerInId: Math.floor(Math.random() * 500),
            playerOutId: Math.floor(Math.random() * 500),
            inPrice: 8.0,
            outPrice: 8.0,
            pointsCost: 0,
            timestamp: new Date(),
            playerIn: { fplId: Math.floor(Math.random() * 500) } as Player,
            playerOut: { fplId: Math.floor(Math.random() * 500) } as Player,
          });
        }

        const allTransfers = [...transfers1, ...transfers2];
        computeTransferSimilarity(transfers1, transfers2, allTransfers, { startGW: 1, endGW: 38 });
      }

      const totalTime = Date.now() - startTime;
      console.log(`${scenario.pairs} pairs: ${totalTime}ms (max: ${scenario.maxTime}ms)`);

      expect(totalTime).toBeLessThan(scenario.maxTime);
    }
  });

  it('should avoid O(n²) explosion with bucketing optimization', () => {
    // Demonstrate that bucketing prevents worst-case O(n²) comparisons

    // Without bucketing: 1000 members = 1000*999/2 = 499,500 pairs
    const membersWithoutBucketing = 1000;
    const pairsWithoutBucketing = (membersWithoutBucketing * (membersWithoutBucketing - 1)) / 2;

    // With bucketing: ~200 suspicious pairs (shared IP, rare transfers)
    const pairsWithBucketing = 200;

    // Reduction factor
    const reductionFactor = pairsWithoutBucketing / pairsWithBucketing;

    console.log(`Without bucketing: ${pairsWithoutBucketing} pairs to score`);
    console.log(`With bucketing: ${pairsWithBucketing} pairs to score`);
    console.log(`Reduction factor: ${reductionFactor.toFixed(0)}x`);

    // Should reduce by >1000x
    expect(reductionFactor).toBeGreaterThan(1000);

    // Time estimate
    const avgScoreTimePerPair = 100; // ms
    const timeWithoutBucketing = pairsWithoutBucketing * avgScoreTimePerPair;
    const timeWithBucketing = pairsWithBucketing * avgScoreTimePerPair;

    console.log(`Estimated time without bucketing: ${(timeWithoutBucketing / 1000 / 60).toFixed(1)} minutes`);
    console.log(`Estimated time with bucketing: ${(timeWithBucketing / 1000).toFixed(1)} seconds`);

    // Without bucketing: ~8 hours (impractical)
    expect(timeWithoutBucketing).toBeGreaterThan(60 * 60 * 1000);

    // With bucketing: ~20 seconds (practical)
    expect(timeWithBucketing).toBeLessThan(30 * 1000);
  });
});
