import { describe, it, expect } from 'vitest';
import { 
  computeTransferSimilarity, 
} from '@/services/league/collusion/transferSimilaritySignal';
import { 
  computeSharedIpScore, 
} from '@/services/league/collusion/sharedIpSignal';
import { SquadTransfer, Player } from '@prisma/client';

/**
 * Reproducibility tests: verify that re-running analysis on the same data
 * produces identical evidence payloads and scores.
 *
 * This is critical for audit compliance and deterministic flag generation.
 */

describe('Reproducibility: Identical Evidence on Re-runs', () => {
  it('should produce identical transfer similarity scores on multiple runs', () => {
    const now = new Date('2026-10-23T12:00:00Z');

    const transfersA: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 1,
        squadId: 'squad1',
        gameweekId: 5,
        playerInId: 100,
        playerOutId: 101,
        inPrice: 9.5,
        outPrice: 9.0,
        pointsCost: 0,
        timestamp: now,
        playerIn: { fplId: 100 } as Player,
        playerOut: { fplId: 101 } as Player,
      },
      {
        id: 2,
        squadId: 'squad1',
        gameweekId: 5,
        playerInId: 200,
        playerOutId: 201,
        inPrice: 8.0,
        outPrice: 7.5,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 15 * 60 * 1000),
        playerIn: { fplId: 200 } as Player,
        playerOut: { fplId: 201 } as Player,
      },
    ];

    const transfersB: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 3,
        squadId: 'squad2',
        gameweekId: 5,
        playerInId: 100,
        playerOutId: 101,
        inPrice: 9.5,
        outPrice: 9.0,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 10 * 60 * 1000),
        playerIn: { fplId: 100 } as Player,
        playerOut: { fplId: 101 } as Player,
      },
      {
        id: 4,
        squadId: 'squad2',
        gameweekId: 5,
        playerInId: 200,
        playerOutId: 201,
        inPrice: 8.0,
        outPrice: 7.5,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 20 * 60 * 1000),
        playerIn: { fplId: 200 } as Player,
        playerOut: { fplId: 201 } as Player,
      },
    ];

    const allTransfers = [...transfersA, ...transfersB];
    const gameweekRange = { startGW: 1, endGW: 10 };

    // Run 1
    const run1 = computeTransferSimilarity(transfersA, transfersB, allTransfers, gameweekRange);

    // Run 2 (identical input)
    const run2 = computeTransferSimilarity(transfersA, transfersB, allTransfers, gameweekRange);

    // Run 3 (should still be identical)
    const run3 = computeTransferSimilarity(transfersA, transfersB, allTransfers, gameweekRange);

    // Scores should be identical
    expect(run1.score).toBe(run2.score);
    expect(run2.score).toBe(run3.score);

    // Evidence should be identical (same object structure)
    expect(JSON.stringify(run1.evidence)).toBe(JSON.stringify(run2.evidence));
    expect(JSON.stringify(run2.evidence)).toBe(JSON.stringify(run3.evidence));
  });

  it('should produce identical JSON evidence across runs (deterministic ordering)', () => {
    const now = new Date('2026-10-23T12:00:00Z');

    const signalsA = [
      { type: 'IP_SUBNET' as const, value: '192.168.1.0/24', userId: 'user1', firstSeenAt: now, lastSeenAt: now },
      { type: 'IP_SUBNET' as const, value: '10.0.0.0/8', userId: 'user1', firstSeenAt: now, lastSeenAt: now },
    ];

    const signalsB = [
      { type: 'IP_SUBNET' as const, value: '192.168.1.0/24', userId: 'user2', firstSeenAt: now, lastSeenAt: now },
      { type: 'IP_SUBNET' as const, value: '172.16.0.0/12', userId: 'user2', firstSeenAt: now, lastSeenAt: now },
    ];

    const allSignals = [...signalsA, ...signalsB];

    // Run 1
    const run1 = computeSharedIpScore(signalsA, signalsB, allSignals);

    // Run 2
    const run2 = computeSharedIpScore(signalsA, signalsB, allSignals);

    // JSON should be bitwise identical (deterministic JSON serialization)
    const json1 = JSON.stringify(run1.evidence);
    const json2 = JSON.stringify(run2.evidence);

    expect(json1).toBe(json2);

    // Verify no floating-point inconsistencies
    expect(run1.score).toBe(run2.score);
  });

  it('should sort evidence elements consistently', () => {
    // Simulate multiple transfers that could be sorted in different orders

    const now = new Date('2026-10-23T12:00:00Z');

    const transfersA: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 1,
        squadId: 'squad1',
        gameweekId: 5,
        playerInId: 100,
        playerOutId: 101,
        inPrice: 9.5,
        outPrice: 9.0,
        pointsCost: 0,
        timestamp: now,
        playerIn: { fplId: 100 } as Player,
        playerOut: { fplId: 101 } as Player,
      },
      {
        id: 2,
        squadId: 'squad1',
        gameweekId: 6,
        playerInId: 200,
        playerOutId: 201,
        inPrice: 8.0,
        outPrice: 7.5,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        playerIn: { fplId: 200 } as Player,
        playerOut: { fplId: 201 } as Player,
      },
      {
        id: 3,
        squadId: 'squad1',
        gameweekId: 5,
        playerInId: 300,
        playerOutId: 301,
        inPrice: 7.0,
        outPrice: 6.5,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 10 * 60 * 1000),
        playerIn: { fplId: 300 } as Player,
        playerOut: { fplId: 301 } as Player,
      },
    ];

    const transfersB: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 10,
        squadId: 'squad2',
        gameweekId: 5,
        playerInId: 100,
        playerOutId: 101,
        inPrice: 9.5,
        outPrice: 9.0,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 5 * 60 * 1000),
        playerIn: { fplId: 100 } as Player,
        playerOut: { fplId: 101 } as Player,
      },
      {
        id: 11,
        squadId: 'squad2',
        gameweekId: 5,
        playerInId: 300,
        playerOutId: 301,
        inPrice: 7.0,
        outPrice: 6.5,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 12 * 60 * 1000),
        playerIn: { fplId: 300 } as Player,
        playerOut: { fplId: 301 } as Player,
      },
    ];

    const allTransfers = [...transfersA, ...transfersB];

    // Run multiple times
    const results = [];
    for (let i = 0; i < 5; i++) {
      const result = computeTransferSimilarity(transfersA, transfersB, allTransfers, { startGW: 1, endGW: 10 });
      results.push(JSON.stringify(result.evidence));
    }

    // All results should be identical
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('should preserve evidence hash for audit trail', () => {
    // Simulate computing an evidence payload and hashing it for audit trail

    const now = new Date('2026-10-23T12:00:00Z');

    const transfersA: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 1,
        squadId: 'squad1',
        gameweekId: 5,
        playerInId: 100,
        playerOutId: 101,
        inPrice: 9.5,
        outPrice: 9.0,
        pointsCost: 0,
        timestamp: now,
        playerIn: { fplId: 100 } as Player,
        playerOut: { fplId: 101 } as Player,
      },
    ];

    const transfersB: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
      {
        id: 2,
        squadId: 'squad2',
        gameweekId: 5,
        playerInId: 100,
        playerOutId: 101,
        inPrice: 9.5,
        outPrice: 9.0,
        pointsCost: 0,
        timestamp: new Date(now.getTime() + 5 * 60 * 1000),
        playerIn: { fplId: 100 } as Player,
        playerOut: { fplId: 101 } as Player,
      },
    ];

    const allTransfers = [...transfersA, ...transfersB];

    // Compute evidence
    const result1 = computeTransferSimilarity(transfersA, transfersB, allTransfers, { startGW: 1, endGW: 10 });

    // Hash the JSON
    const crypto = require('crypto');
    const hash1 = crypto
      .createHash('sha256')
      .update(JSON.stringify(result1.evidence))
      .digest('hex');

    // Re-run and hash again
    const result2 = computeTransferSimilarity(transfersA, transfersB, allTransfers, { startGW: 1, endGW: 10 });
    const hash2 = crypto
      .createHash('sha256')
      .update(JSON.stringify(result2.evidence))
      .digest('hex');

    // Hashes should be identical (evidence is deterministic)
    expect(hash1).toBe(hash2);
  });

  it('should handle edge cases consistently', () => {
    // Test edge cases that might produce different results on different runs
    // (e.g., floating-point arithmetic, random ordering)

    // Edge case 1: Empty transfers
    const run1Empty = computeTransferSimilarity([], [], [], { startGW: 1, endGW: 10 });
    const run2Empty = computeTransferSimilarity([], [], [], { startGW: 1, endGW: 10 });

    expect(JSON.stringify(run1Empty)).toBe(JSON.stringify(run2Empty));

    // Edge case 2: Single transfer
    const now = new Date();
    const singleTransfer: (SquadTransfer & { playerIn: Player; playerOut: Player })[] = [
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

    const run1Single = computeTransferSimilarity([singleTransfer[0]], [], [singleTransfer[0]], {
      startGW: 1,
      endGW: 10,
    });
    const run2Single = computeTransferSimilarity([singleTransfer[0]], [], [singleTransfer[0]], {
      startGW: 1,
      endGW: 10,
    });

    expect(JSON.stringify(run1Single)).toBe(JSON.stringify(run2Single));
  });
});
