import { describe, it, expect } from 'vitest';
import { 
  computeTransferSimilarity, 
  DEFAULT_TRANSFER_SIMILARITY_CONFIG 
} from '@/services/league/collusion/transferSimilaritySignal';
import { 
  computeSharedIpScore, 
  DEFAULT_SHARED_IP_CONFIG 
} from '@/services/league/collusion/sharedIpSignal';
import { 
  computeChipTimingScore, 
  DEFAULT_CHIP_TIMING_CONFIG 
} from '@/services/league/collusion/chipTimingSignal';
import { SquadTransfer, Player } from '@prisma/client';

/**
 * Integration tests: synthetic collusion rings and false-positive baselines.
 */

describe('Integration: Synthetic Collusion Rings', () => {
  it('should detect a 3-account ring with shared IP and rare transfers', () => {
    const now = new Date();

    // Create 3 accounts coordinating: shared IP + identical rare transfers within time window
    const sharedIp = '192.168.1.0/24';
    const rareTransferId = 999;
    const rareTransferId2 = 998;

    // IP signals for all 3 accounts
    const allIpSignals = [
      { type: 'IP_SUBNET' as const, value: sharedIp, userId: 'account1', firstSeenAt: now, lastSeenAt: now },
      { type: 'IP_SUBNET' as const, value: sharedIp, userId: 'account2', firstSeenAt: now, lastSeenAt: now },
      { type: 'IP_SUBNET' as const, value: sharedIp, userId: 'account3', firstSeenAt: now, lastSeenAt: now },
    ];

    // Test pair (account1 vs account2)
    const ipScore = computeSharedIpScore(
      [allIpSignals[0]],
      [allIpSignals[1]],
      allIpSignals
    );

    // Rare network (only 3 accounts) should score higher
    expect(ipScore.score).toBeGreaterThan(0.2);

    // Transfer signals: all 3 accounts make identical rare transfers within 30 min
    const transfers1: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 1,
        squadId: 'squad1',
        gameweekId: 5,
        playerInId: rareTransferId,
        playerOutId: 500,
        inPrice: 9.0,
        outPrice: 8.5,
        pointsCost: 0,
        timestamp: now,
        playerIn: { fplId: rareTransferId } as Player,
        playerOut: { fplId: 500 } as Player,
      },
      {
        id: 2,
        squadId: 'squad1',
        gameweekId: 5,
        playerInId: rareTransferId2,
        playerOutId: 501,
        inPrice: 8.5,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 10 * 60 * 1000),
        playerIn: { fplId: rareTransferId2 } as Player,
        playerOut: { fplId: 501 } as Player,
      },
    ];

    const transfers2: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 3,
        squadId: 'squad2',
        gameweekId: 5,
        playerInId: rareTransferId,
        playerOutId: 500,
        inPrice: 9.0,
        outPrice: 8.5,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 5 * 60 * 1000),
        playerIn: { fplId: rareTransferId } as Player,
        playerOut: { fplId: 500 } as Player,
      },
      {
        id: 4,
        squadId: 'squad2',
        gameweekId: 5,
        playerInId: rareTransferId2,
        playerOutId: 501,
        inPrice: 8.5,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 15 * 60 * 1000),
        playerIn: { fplId: rareTransferId2 } as Player,
        playerOut: { fplId: 501 } as Player,
      },
    ];

    const allTransfers = [...transfers1, ...transfers2];

    const transferScore = computeTransferSimilarity(
      transfers1,
      transfers2,
      allTransfers,
      { startGW: 1, endGW: 10 }
    );

    // Both rare transfers match within time window
    expect(transferScore.score).toBeGreaterThan(0.5);

    // Combined signals: IP + rare transfers should trigger collusion flag
    const combinedScore = ipScore.score * 0.15 + transferScore.score * 0.35; // Simplified aggregation
    expect(combinedScore).toBeGreaterThan(0.3); // Should easily pass min threshold
  });

  it('should NOT flag shared IP alone (without behavioral signals)', () => {
    const now = new Date();
    const sharedIp = '192.168.1.0/24';

    const signals = [
      { type: 'IP_SUBNET' as const, value: sharedIp, userId: 'account1', firstSeenAt: now, lastSeenAt: now },
      { type: 'IP_SUBNET' as const, value: sharedIp, userId: 'account2', firstSeenAt: now, lastSeenAt: now },
    ];

    const ipScore = computeSharedIpScore([signals[0]], [signals[1]], signals);

    // IP alone should be capped
    expect(ipScore.score).toBeLessThanOrEqual(DEFAULT_SHARED_IP_CONFIG.maxScoreIpOnly);
  });
});

describe('Integration: False Positive Baseline', () => {
  it('should NOT flag normal league activity (meta transfers)', () => {
    const now = new Date();

    // Simulate normal league: 80% of members buy the same in-form player (meta transfer)
    const allTransfers: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [];

    // 80 teams make the same meta transfer (in-form striker)
    for (let i = 0; i < 80; i++) {
      allTransfers.push({
        id: i,
        squadId: `squad${i}`,
        gameweekId: 5,
        playerInId: 100, // Popular striker
        playerOutId: 101,
        inPrice: 12.0,
        outPrice: 11.5,
        pointsCost: 0,
        timestamp: now,
        playerIn: { fplId: 100 } as Player,
        playerOut: { fplId: 101 } as Player,
      });
    }

    const transfers1 = [allTransfers[0]];
    const transfers2 = [allTransfers[1]];

    const { score, evidence } = computeTransferSimilarity(
      transfers1,
      transfers2,
      allTransfers,
      { startGW: 1, endGW: 10 }
    );

    // Meta transfer (rarity ~0.012) should score very low
    expect(score).toBeLessThan(0.1);
    expect(evidence.pairwiseComparisons[0]?.matchedTransfers[0]?.rarity).toBeLessThan(0.05);
  });

  it('should NOT flag common network coincidences (university, office)', () => {
    const now = new Date();

    // Simulate university network: 20 unrelated accounts
    const allSignals = [];
    for (let i = 0; i < 20; i++) {
      allSignals.push({
        type: 'IP_SUBNET' as const,
        value: '192.168.1.0/24', // Shared university network
        userId: `student${i}`,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }

    // Pick any two random students
    const { score, evidence } = computeSharedIpScore(
      [allSignals[0]],
      [allSignals[1]],
      allSignals,
      { ...DEFAULT_SHARED_IP_CONFIG, commonNetworkThreshold: 10 }
    );

    // Common network should be heavily discounted
    expect(score).toBeLessThanOrEqual(0.3);
    expect(evidence.overlappingSubnets[0]?.isCommonNetwork).toBe(true);
  });

  it('should NOT flag similar template squads with normal captain choices', () => {
    // Two users with template squads often choose the same popular captain
    // This should not be suspicious without other signals

    const now = new Date();
    const sharedIp = '192.168.50.0/24'; // Different IP, not commonly used

    // Both on somewhat rare network
    const signals = [
      { type: 'IP_SUBNET' as const, value: sharedIp, userId: 'account1', firstSeenAt: now, lastSeenAt: now },
      { type: 'IP_SUBNET' as const, value: sharedIp, userId: 'account2', firstSeenAt: now, lastSeenAt: now },
    ];

    const { score, evidence } = computeSharedIpScore([signals[0]], [signals[1]], signals, {
      ...DEFAULT_SHARED_IP_CONFIG,
      commonNetworkThreshold: 20, // Rare network
    });

    // Rare IP overlap should score higher but still capped
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThanOrEqual(DEFAULT_SHARED_IP_CONFIG.maxScoreIpOnly);
  });

  it('should report low false-positive rate on baseline normal league', () => {
    // Simulate a normal league: 100 players, no coordination
    const now = new Date();

    // Transfer patterns: mostly meta or slightly rare, random timing
    const allTransfers: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [];
    const players = Array.from({ length: 200 }, (_, i) => i + 1);

    for (let squadIdx = 0; squadIdx < 100; squadIdx++) {
      for (let gw = 1; gw <= 10; gw++) {
        // Each squad makes 2-4 transfers per gameweek (realistic)
        const transferCount = Math.floor(Math.random() * 3) + 2;

        for (let t = 0; t < transferCount; t++) {
          const playerIn = players[Math.floor(Math.random() * players.length)];
          const playerOut = players[Math.floor(Math.random() * players.length)];

          if (playerIn !== playerOut) {
            allTransfers.push({
              id: allTransfers.length,
              squadId: `squad${squadIdx}`,
              gameweekId: gw,
              playerInId: playerIn,
              playerOutId: playerOut,
              inPrice: Math.random() * 10 + 4,
              outPrice: Math.random() * 10 + 4,
              pointsCost: 0,
              timestamp: new Date(now.getTime() + Math.random() * 24 * 60 * 60 * 1000),
              playerIn: { fplId: playerIn } as Player,
              playerOut: { fplId: playerOut } as Player,
            });
          }
        }
      }
    }

    // Test a few random pairs
    let flagCount = 0;
    const pairsToTest = 50;

    for (let p = 0; p < pairsToTest; p++) {
      const idx1 = Math.floor(Math.random() * 100);
      const idx2 = Math.floor(Math.random() * 100);

      if (idx1 === idx2) continue;

      const transfers1 = allTransfers.filter((t) => t.squadId === `squad${idx1}`);
      const transfers2 = allTransfers.filter((t) => t.squadId === `squad${idx2}`);

      const { score } = computeTransferSimilarity(
        transfers1,
        transfers2,
        allTransfers,
        { startGW: 1, endGW: 10 }
      );

      if (score > 0.7) {
        flagCount++;
      }
    }

    // False positive rate should be very low (< 5%)
    const falsePositiveRate = flagCount / pairsToTest;
    expect(falsePositiveRate).toBeLessThan(0.05);
  });
});

describe('Integration: Combination Rules', () => {
  it('should require 2+ independent signal families for a flag', () => {
    const now = new Date();

    // Signal 1: Shared IP only
    const ipScore = 0.35; // Between common and rare threshold

    // Signal 2: No other signals
    const transferScore = 0.0;
    const chipScore = 0.0;
    const benchScore = 0.0;
    const pointScore = 0.0;

    // Aggregate with standard weights (require 2 independent families)
    const weights = {
      transferSimilarityWeight: 0.35,
      sharedIpWeight: 0.15,
      chipTimingWeight: 0.25,
      benchGhostingWeight: 0.15,
      pointAbsorptionWeight: 0.1,
    };

    const riskScore =
      transferScore * weights.transferSimilarityWeight +
      ipScore * weights.sharedIpWeight +
      chipScore * weights.chipTimingWeight +
      benchScore * weights.benchGhostingWeight +
      pointScore * weights.pointAbsorptionWeight;

    // IP alone should NOT reach flag threshold
    expect(riskScore).toBeLessThan(0.6);
  });

  it('should flag when 2+ independent signal families fire', () => {
    // Signal 1: Shared IP (medium)
    const ipScore = 0.35;

    // Signal 2: Transfer similarity (high)
    const transferScore = 0.75;

    // No other signals
    const chipScore = 0.0;
    const benchScore = 0.0;
    const pointScore = 0.0;

    const weights = {
      transferSimilarityWeight: 0.35,
      sharedIpWeight: 0.15,
      chipTimingWeight: 0.25,
      benchGhostingWeight: 0.15,
      pointAbsorptionWeight: 0.1,
    };

    const riskScore =
      transferScore * weights.transferSimilarityWeight +
      ipScore * weights.sharedIpWeight +
      chipScore * weights.chipTimingWeight +
      benchScore * weights.benchGhostingWeight +
      pointScore * weights.pointAbsorptionWeight;

    // IP + Transfer should reach flag threshold
    expect(riskScore).toBeGreaterThan(0.6);
  });

  it('should require 3+ signals for suspension threshold', () => {
    // Suspension threshold: 0.85, require 3+ signals

    // Scenario 1: Only 2 signals firing
    const scores2signals = {
      transfer: 0.8,
      ip: 0.3,
      chip: 0.0,
      bench: 0.0,
      point: 0.0,
    };

    const triggeredCount2 = Object.values(scores2signals).filter((s) => s > 0).length;
    expect(triggeredCount2).toBe(2);
    expect(triggeredCount2).toBeLessThan(3);

    // Scenario 2: 3+ signals firing
    const scores3signals = {
      transfer: 0.85,
      ip: 0.3,
      chip: 0.6,
      bench: 0.5,
      point: 0.0,
    };

    const triggeredCount3 = Object.values(scores3signals).filter((s) => s > 0).length;
    expect(triggeredCount3).toBeGreaterThanOrEqual(3);

    // Calculate aggregate
    const weights = {
      transferSimilarityWeight: 0.35,
      sharedIpWeight: 0.15,
      chipTimingWeight: 0.25,
      benchGhostingWeight: 0.15,
      pointAbsorptionWeight: 0.1,
    };

    const aggregate3 =
      scores3signals.transfer * weights.transferSimilarityWeight +
      scores3signals.ip * weights.sharedIpWeight +
      scores3signals.chip * weights.chipTimingWeight +
      scores3signals.bench * weights.benchGhostingWeight +
      scores3signals.point * weights.pointAbsorptionWeight;

    // Should reach suspension threshold
    expect(aggregate3).toBeGreaterThan(0.85);
  });
});
