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
import { 
  computeBenchGhostingScore, 
  DEFAULT_BENCH_GHOSTING_CONFIG,
  SquadLineup 
} from '@/services/league/collusion/benchGhostingSignal';
import { 
  computePointAbsorptionScore, 
  DEFAULT_POINT_ABSORPTION_CONFIG 
} from '@/services/league/collusion/pointAbsorptionSignal';
import { SquadTransfer, Player, SquadChipUsage } from '@prisma/client';

// ============================================================
// Transfer Similarity Tests
// ============================================================

describe('Transfer Similarity Signal', () => {
  it('should score 0 for empty transfer sequences', () => {
    const { score } = computeTransferSimilarity([], [], [], { startGW: 1, endGW: 5 });
    expect(score).toBe(0);
  });

  it('should score 0 for completely different transfers', () => {
    const transfersA: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 1,
        squadId: 'squad1',
        gameweekId: 1,
        playerInId: 1,
        playerOutId: 2,
        inPrice: 8.0,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: new Date(),
        playerIn: { fplId: 1 } as Player,
        playerOut: { fplId: 2 } as Player,
      },
    ];

    const transfersB: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 2,
        squadId: 'squad2',
        gameweekId: 1,
        playerInId: 3,
        playerOutId: 4,
        inPrice: 8.0,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: new Date(),
        playerIn: { fplId: 3 } as Player,
        playerOut: { fplId: 4 } as Player,
      },
    ];

    const { score } = computeTransferSimilarity(transfersA, transfersB, [...transfersA, ...transfersB], {
      startGW: 1,
      endGW: 5,
    });
    expect(score).toBe(0);
  });

  it('should score high for identical rare transfers', () => {
    const now = new Date();
    const transfersA: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 1,
        squadId: 'squad1',
        gameweekId: 1,
        playerInId: 1,
        playerOutId: 2,
        inPrice: 8.0,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: now,
        playerIn: { fplId: 1 } as Player,
        playerOut: { fplId: 2 } as Player,
      },
    ];

    const transfersB: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 2,
        squadId: 'squad2',
        gameweekId: 1,
        playerInId: 1,
        playerOutId: 2,
        inPrice: 8.0,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 5 * 60 * 1000), // 5 minutes later
        playerIn: { fplId: 1 } as Player,
        playerOut: { fplId: 2 } as Player,
      },
    ];

    const { score } = computeTransferSimilarity(transfersA, transfersB, [...transfersA, ...transfersB], {
      startGW: 1,
      endGW: 5,
    });

    // Both made the same rare transfer (only 2 total) within time window
    // Rarity weight: 1 / (1 + 2) = 0.33
    // Similarity normalized: should be reasonably high
    expect(score).toBeGreaterThan(0.2);
  });

  it('should score low for meta transfers (many teams make them)', () => {
    const now = new Date();
    // Simulate 80% of league making the same transfer (meta)
    const allTransfers: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [];

    for (let i = 0; i < 80; i++) {
      allTransfers.push({
        id: i,
        squadId: `squad${i}`,
        gameweekId: 1,
        playerInId: 100,
        playerOutId: 101,
        inPrice: 8.0,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: now,
        playerIn: { fplId: 100 } as Player,
        playerOut: { fplId: 101 } as Player,
      });
    }

    const transfersA = allTransfers.slice(0, 1);
    const transfersB = allTransfers.slice(1, 2);

    const { score, evidence } = computeTransferSimilarity(transfersA, transfersB, allTransfers, {
      startGW: 1,
      endGW: 5,
    });

    // Meta transfer: rarity = 1 / (1 + 80) = 0.012
    // Score should be very low
    expect(score).toBeLessThan(0.1);
    expect(evidence.pairwiseComparisons[0]?.matchedTransfers[0]?.rarity).toBeLessThan(0.05);
  });

  it('should respect time window configuration', () => {
    const now = new Date();
    const transfersA: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 1,
        squadId: 'squad1',
        gameweekId: 1,
        playerInId: 1,
        playerOutId: 2,
        inPrice: 8.0,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: now,
        playerIn: { fplId: 1 } as Player,
        playerOut: { fplId: 2 } as Player,
      },
    ];

    const transfersB: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 2,
        squadId: 'squad2',
        gameweekId: 1,
        playerInId: 1,
        playerOutId: 2,
        inPrice: 8.0,
        outPrice: 8.0,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 45 * 60 * 1000), // 45 minutes later
        playerIn: { fplId: 1 } as Player,
        playerOut: { fplId: 2 } as Player,
      },
    ];

    // With default window (30 min), should score 0 (outside window)
    const { score: score30 } = computeTransferSimilarity(transfersA, transfersB, [...transfersA, ...transfersB], {
      startGW: 1,
      endGW: 5,
    });
    expect(score30).toBe(0);

    // With extended window (60 min), should score high
    const { score: score60 } = computeTransferSimilarity(transfersA, transfersB, [...transfersA, ...transfersB], {
      startGW: 1,
      endGW: 5,
    }, {
      ...DEFAULT_TRANSFER_SIMILARITY_CONFIG,
      timeWindowMinutes: 60,
    });
    expect(score60).toBeGreaterThan(0.2);
  });
});

// ============================================================
// Shared IP Tests
// ============================================================

describe('Shared IP Signal', () => {
  it('should score 0 for no overlapping IPs', () => {
    const signalsA = [
      { type: 'IP_SUBNET' as const, value: '192.168.1.0/24', userId: 'user1', firstSeenAt: new Date(), lastSeenAt: new Date() },
    ];
    const signalsB = [
      { type: 'IP_SUBNET' as const, value: '10.0.0.0/24', userId: 'user2', firstSeenAt: new Date(), lastSeenAt: new Date() },
    ];

    const { score } = computeSharedIpScore(signalsA, signalsB, [...signalsA, ...signalsB]);
    expect(score).toBe(0);
  });

  it('should score low for overlapping IPs on common networks', () => {
    const now = new Date();
    // Simulate university network with many accounts
    const allSignals = [];
    for (let i = 0; i < 15; i++) {
      allSignals.push({
        type: 'IP_SUBNET' as const,
        value: '192.168.1.0/24',
        userId: `user${i}`,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }

    const signalsA = [allSignals[0]];
    const signalsB = [allSignals[1]];

    const { score, evidence } = computeSharedIpScore(signalsA as any, signalsB as any, allSignals as any, {
      ...DEFAULT_SHARED_IP_CONFIG,
      commonNetworkThreshold: 10,
    });

    // Shared IP on common network (>10 accounts) should be discounted
    expect(score).toBeLessThanOrEqual(0.4);
    expect(evidence.overlappingSubnets[0]?.isCommonNetwork).toBe(true);
  });

  it('should score high for overlapping IPs on rare networks', () => {
    const now = new Date();
    const signalsA = [
      { type: 'IP_SUBNET' as const, value: '203.0.113.0/24', userId: 'user1', firstSeenAt: now, lastSeenAt: now },
    ];
    const signalsB = [
      { type: 'IP_SUBNET' as const, value: '203.0.113.0/24', userId: 'user2', firstSeenAt: now, lastSeenAt: now },
    ];

    // Only these 2 accounts on this subnet
    const allSignals = [...signalsA, ...signalsB];

    const { score, evidence } = computeSharedIpScore(signalsA as any, signalsB as any, allSignals as any);

    // Rare subnet should score higher
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThanOrEqual(0.4); // But capped at maxScoreIpOnly
    expect(evidence.overlappingSubnets[0]?.isCommonNetwork).toBe(false);
  });

  it('should never exceed maxScoreIpOnly threshold alone', () => {
    const now = new Date();
    const signalsA = [
      { type: 'IP_SUBNET' as const, value: '203.0.113.0/24', userId: 'user1', firstSeenAt: now, lastSeenAt: now },
    ];
    const signalsB = [
      { type: 'IP_SUBNET' as const, value: '203.0.113.0/24', userId: 'user2', firstSeenAt: now, lastSeenAt: now },
    ];

    const allSignals = [...signalsA, ...signalsB];
    const { score } = computeSharedIpScore(signalsA as any, signalsB as any, allSignals as any);

    expect(score).toBeLessThanOrEqual(DEFAULT_SHARED_IP_CONFIG.maxScoreIpOnly);
  });
});

// ============================================================
// Chip Timing Tests
// ============================================================

describe('Chip Timing Signal', () => {
  it('should score 0 for empty chip usages', () => {
    const { score } = computeChipTimingScore([], [], [], null, 50, { startGW: 1, endGW: 5 });
    expect(score).toBe(0);
  });

  it('should score 0 for insufficient gameweeks', () => {
    const chips = [
      {
        squadId: 'squad1',
        chipType: 'FREE_HIT',
        gameweekId: 1,
        usedAt: new Date(),
      },
    ];

    const { score } = computeChipTimingScore(chips, [], [...chips], null, 50, { startGW: 1, endGW: 3 });
    expect(score).toBe(0);
  });

  it('should detect unusually early chip plays', () => {
    const allChips = [];
    for (let gw = 1; gw <= 10; gw++) {
      // Base rate: 2 teams play Free Hit per gameweek
      if (gw === 3 || gw === 7) {
        allChips.push({
          squadId: `squad${gw}`,
          chipType: 'FREE_HIT',
          gameweekId: gw,
          usedAt: new Date(),
        });
      }
    }

    // Account A plays Free Hit in GW5 (unusual: only 2 teams in 10 weeks)
    const chipsA = [
      {
        squadId: 'squad_a',
        chipType: 'FREE_HIT',
        gameweekId: 5,
        usedAt: new Date(),
      },
    ];

    const { score, evidence } = computeChipTimingScore(chipsA, [], allChips, null, 50, { startGW: 1, endGW: 10 });

    // Deviation from base rate should be detected
    expect(score).toBeGreaterThan(0);
    expect(evidence.events.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Bench Ghosting Tests
// ============================================================

describe('Bench Ghosting Signal', () => {
  it('should score 0 for no mirroring', () => {
    const lineupsA: SquadLineup[] = [
      { gameweekId: 1, captainPlayerId: 1, viceCaptainPlayerId: 2, benchOrder: [10, 11, 12, 13] },
      { gameweekId: 2, captainPlayerId: 3, viceCaptainPlayerId: 4, benchOrder: [20, 21, 22, 23] },
      { gameweekId: 3, captainPlayerId: 5, viceCaptainPlayerId: 6, benchOrder: [30, 31, 32, 33] },
    ];

    const lineupsB: SquadLineup[] = [
      { gameweekId: 1, captainPlayerId: 100, viceCaptainPlayerId: 101, benchOrder: [110, 111, 112, 113] },
      { gameweekId: 2, captainPlayerId: 102, viceCaptainPlayerId: 103, benchOrder: [120, 121, 122, 123] },
      { gameweekId: 3, captainPlayerId: 104, viceCaptainPlayerId: 105, benchOrder: [130, 131, 132, 133] },
    ];

    const { score } = computeBenchGhostingScore(lineupsA, lineupsB, { startGW: 1, endGW: 3 });
    expect(score).toBe(0);
  });

  it('should detect captain mirroring', () => {
    const lineupsA: SquadLineup[] = [
      { gameweekId: 1, captainPlayerId: 10, viceCaptainPlayerId: 11, benchOrder: [100, 101, 102] },
      { gameweekId: 2, captainPlayerId: 10, viceCaptainPlayerId: 11, benchOrder: [100, 101, 102] },
      { gameweekId: 3, captainPlayerId: 10, viceCaptainPlayerId: 11, benchOrder: [100, 101, 102] },
      { gameweekId: 4, captainPlayerId: 10, viceCaptainPlayerId: 11, benchOrder: [100, 101, 102] },
      { gameweekId: 5, captainPlayerId: 10, viceCaptainPlayerId: 11, benchOrder: [100, 101, 102] },
    ];

    const lineupsB: SquadLineup[] = [
      { gameweekId: 1, captainPlayerId: 10, viceCaptainPlayerId: 99, benchOrder: [200, 201, 202] },
      { gameweekId: 2, captainPlayerId: 10, viceCaptainPlayerId: 99, benchOrder: [200, 201, 202] },
      { gameweekId: 3, captainPlayerId: 10, viceCaptainPlayerId: 99, benchOrder: [200, 201, 202] },
      { gameweekId: 4, captainPlayerId: 10, viceCaptainPlayerId: 99, benchOrder: [200, 201, 202] },
      { gameweekId: 5, captainPlayerId: 10, viceCaptainPlayerId: 99, benchOrder: [200, 201, 202] },
    ];

    const { score, evidence } = computeBenchGhostingScore(lineupsA, lineupsB, { startGW: 1, endGW: 5 });

    // Multiple captain mirrors should be statistically significant
    expect(score).toBeGreaterThan(0);
    expect(evidence.totalOccurrences).toBeGreaterThanOrEqual(3);
    expect(evidence.probabilityByChance).toBeLessThan(0.05);
  });

  it('should evaluate statistical significance correctly', () => {
    // Single mirroring event should not be significant
    const lineupsA: SquadLineup[] = [
      { gameweekId: 1, captainPlayerId: 10, viceCaptainPlayerId: 11, benchOrder: [100, 101, 102] },
      { gameweekId: 2, captainPlayerId: 20, viceCaptainPlayerId: 21, benchOrder: [200, 201, 202] },
    ];

    const lineupsB: SquadLineup[] = [
      { gameweekId: 1, captainPlayerId: 10, viceCaptainPlayerId: 11, benchOrder: [300, 301, 302] },
      { gameweekId: 2, captainPlayerId: 30, viceCaptainPlayerId: 31, benchOrder: [400, 401, 402] },
    ];

    const { score } = computeBenchGhostingScore(lineupsA, lineupsB, { startGW: 1, endGW: 2 });

    // Single event should not reach significance threshold
    expect(score).toBeLessThan(0.5);
  });
});

// ============================================================
// Point Absorption Tests
// ============================================================

describe('Point Absorption Signal', () => {
  it('should score 0 for insufficient gameweeks', () => {
    const scoresA = [
      { gameweekId: 1, points: 50, transferCost: 0 },
      { gameweekId: 2, points: 45, transferCost: -4 },
    ];

    const scoresB = [
      { gameweekId: 1, points: 40, transferCost: 0 },
      { gameweekId: 2, points: 60, transferCost: 0 },
    ];

    const { score } = computePointAbsorptionScore(scoresA, scoresB, { startGW: 1, endGW: 2 });
    expect(score).toBe(0);
  });

  it('should detect positive correlation between costs and gains', () => {
    // A consistently takes hits when B scores high
    const scoresA = Array.from({ length: 15 }, (_, i) => ({
      gameweekId: i + 1,
      points: 40,
      transferCost: i % 2 === 0 ? -4 : 0, // alternating hits
    }));

    const scoresB = Array.from({ length: 15 }, (_, i) => ({
      gameweekId: i + 1,
      points: i % 2 === 0 ? 80 : 20, // higher points when A takes hit
      transferCost: 0,
    }));

    const { score, evidence } = computePointAbsorptionScore(scoresA, scoresB, { startGW: 1, endGW: 15 });

    // Positive correlation should be detected
    expect(evidence.pearsonCorrelation).toBeGreaterThan(0);
    if (evidence.pearsonCorrelation > 0.6) {
      expect(score).toBeGreaterThan(0);
    }
  });

  it('should score 0 for no correlation', () => {
    // Random costs and gains with no correlation
    const scoresA = Array.from({ length: 15 }, (_, i) => ({
      gameweekId: i + 1,
      points: 40,
      transferCost: Math.random() > 0.5 ? -4 : 0,
    }));

    const scoresB = Array.from({ length: 15 }, (_, i) => ({
      gameweekId: i + 1,
      points: Math.floor(Math.random() * 100),
      transferCost: 0,
    }));

    const { score, evidence } = computePointAbsorptionScore(scoresA, scoresB, { startGW: 1, endGW: 15 });

    // No correlation should mean no score
    if (evidence.pearsonCorrelation < 0.6) {
      expect(score).toBe(0);
    }
  });
});
