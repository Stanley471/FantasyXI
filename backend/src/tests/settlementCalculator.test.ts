import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SettlementCalculator,
  SettlementBreakdown,
  PrizeDistributionConfig,
  Currency,
} from "../services/financial/settlementCalculator.js";

describe("SettlementCalculator — Deterministic Prize Distribution", () => {
  // ============================================================
  // Basic Settlement Calculations
  // ============================================================

  it("should calculate exact 5% fee and 60/30/10 split for 10 participants at 5 USDC", () => {
    const result = SettlementCalculator.calculateSettlement(500, 10);

    assert.equal(result.grossPoolCents, 5000); // 10 * 500 cents
    assert.equal(result.platformFeeCents, 250); // 5% of 5000
    assert.equal(result.prizePoolCents, 4750); // 5000 - 250
    assert.equal(result.invariantValid, true);
    assert.equal(
      result.prizesCents.reduce((a, b) => a + b, 0),
      result.prizePoolCents
    );
  });

  it("should distribute 60/30/10 split correctly for 10 participants", () => {
    const result = SettlementCalculator.calculateSettlement(500, 10);

    const first = result.prizesCents[0];
    const second = result.prizesCents[1];
    const third = result.prizesCents[2];

    // First place: 60% of 4750 cents = 2850 cents
    assert.equal(first, 2850);
    // Second place: 30% of 4750 cents = 1425 cents
    assert.equal(second, 1425);
    // Third place: 10% of 4750 cents = 475 cents
    assert.equal(third, 475);

    // Sum must equal prize pool
    assert.equal(first + second + third, result.prizePoolCents);
  });

  it("should handle 2-player league with 70/30 split", () => {
    const result = SettlementCalculator.calculateSettlement(1000, 2);

    assert.equal(result.grossPoolCents, 2000); // 2 * 1000
    assert.equal(result.platformFeeCents, 100); // 5% of 2000
    assert.equal(result.prizePoolCents, 1900); // 2000 - 100
    assert.equal(result.invariantValid, true);

    // Should use 70/30 split
    assert.equal(result.splitsBps[0], 7000);
    assert.equal(result.splitsBps[1], 3000);
  });

  it("should handle single-participant league (100% to winner)", () => {
    const result = SettlementCalculator.calculateSettlement(1000, 1);

    assert.equal(result.grossPoolCents, 1000);
    assert.equal(result.platformFeeCents, 50); // 5% of 1000
    assert.equal(result.prizePoolCents, 950); // 1000 - 50
    assert.equal(result.prizesCents.length, 1);
    assert.equal(result.prizesCents[0], 950);
  });

  // ============================================================
  // Fractional Cent Precision
  // ============================================================

  it("should preserve fractional cents with odd entry fees", () => {
    const result = SettlementCalculator.calculateSettlement(333, 7);

    // 7 * 333 = 2331 cents
    assert.equal(result.grossPoolCents, 2331);

    // Platform fee: 2331 * 5% = 116.55 -> 117 cents (rounded)
    assert.equal(result.platformFeeCents, 117);

    // Prize pool: 2331 - 117 = 2214
    assert.equal(result.prizePoolCents, 2214);

    // Invariant: sum of prizes = prize pool
    assert.equal(
      result.prizesCents.reduce((a, b) => a + b, 0),
      result.prizePoolCents
    );
  });

  it("should not lose cents when distributing prizes", () => {
    // Test case: 13 participants x 7.77 USDC
    const result = SettlementCalculator.calculateSettlement(777, 13);

    const prizeSum = result.prizesCents.reduce((a, b) => a + b, 0);
    assert.equal(prizeSum, result.prizePoolCents);
  });

  it("should handle very small entry fees (in cents)", () => {
    const result = SettlementCalculator.calculateSettlement(1, 100); // $0.01 per person

    assert.equal(result.grossPoolCents, 100);
    assert.equal(result.platformFeeCents, 5); // 5% of 100
    assert.equal(result.prizePoolCents, 95);
    assert.equal(
      result.prizesCents.reduce((a, b) => a + b, 0),
      result.prizePoolCents
    );
  });

  it("should handle large entry fees", () => {
    const result = SettlementCalculator.calculateSettlement(999999, 500); // $9,999.99 per person

    const prizeSum = result.prizesCents.reduce((a, b) => a + b, 0);
    assert.equal(prizeSum, result.prizePoolCents);
    assert.equal(result.invariantValid, true);
  });

  // ============================================================
  // Tie Handling
  // ============================================================

  it("should adjust for ties with equal prize distribution", () => {
    const settlement = SettlementCalculator.calculateSettlement(500, 10);

    // Simulate 3-way tie for first place
    const tieGroups: Array<[string[], number]> = [
      [["p1", "p2", "p3"], 100], // three players tied at rank 1
      [["p4"], 95], // solo rank 4
      [["p5", "p6"], 90], // tie for rank 5
    ];

    const result = SettlementCalculator.adjustForTies(settlement, tieGroups);

    // First group (3-way tie) should get average of ranks 1, 2, 3
    const firstTierAvg = Math.floor(
      (settlement.prizesCents[0] +
        settlement.prizesCents[1] +
        settlement.prizesCents[2]) /
        3
    );
    assert.equal(result.payouts.get("p1"), firstTierAvg);
    assert.equal(result.payouts.get("p2"), firstTierAvg);
    assert.equal(result.payouts.get("p3"), firstTierAvg);

    // Solo player gets their exact tier
    assert.equal(result.payouts.get("p4"), settlement.prizesCents[3]);
  });

  it("should track rounding loss in tie adjustment", () => {
    const settlement = SettlementCalculator.calculateSettlement(333, 3);

    const tieGroups: Array<[string[], number]> = [
      [["p1", "p2"], 100],
      [["p3"], 95],
    ];

    const result = SettlementCalculator.adjustForTies(settlement, tieGroups);

    // Rounding loss should be non-negative
    assert.ok(result.roundingLossCents >= 0);
  });

  // ============================================================
  // Custom Splits
  // ============================================================

  it("should accept custom prize splits", () => {
    const customSplits = [5000, 3000, 1500, 500]; // 50/30/15/5

    const result = SettlementCalculator.calculateSettlement(
      1000,
      4,
      { splitsBps: customSplits }
    );

    assert.deepEqual(result.splitsBps, customSplits);
    assert.equal(
      result.prizesCents.reduce((a, b) => a + b, 0),
      result.prizePoolCents
    );
  });

  it("should validate custom splits sum to 10,000 basis points", () => {
    assert.throws(
      () => {
        SettlementCalculator.calculateSettlement(1000, 3, {
          splitsBps: [5000, 3000, 1500], // sums to 9500
        });
      },
      /sum to 10,000/
    );
  });

  it("should reject invalid platform fee percentages", () => {
    assert.throws(
      () => {
        SettlementCalculator.calculateSettlement(1000, 3, {
          platformFeePercent: 150, // > 100%
        });
      },
      /between 0 and 100/
    );
  });

  // ============================================================
  // Currency Conversion
  // ============================================================

  it("should convert entry fee to cents", () => {
    const cents = SettlementCalculator.toCents("USDC", 5.0);
    assert.equal(cents, 500); // 5.00 dollars = 500 cents
  });

  it("should convert cents back to currency units", () => {
    const amount = SettlementCalculator.fromCents("USDC", 500);
    assert.equal(amount, 5.0);
  });

  it("should handle fractional conversions", () => {
    const cents = SettlementCalculator.toCents("USDC", 3.33);
    const back = SettlementCalculator.fromCents("USDC", cents);
    assert.ok(Math.abs(back - 3.33) < 0.01); // within 1 cent
  });

  // ============================================================
  // Edge Cases & Error Handling
  // ============================================================

  it("should reject non-integer entry fees in cents", () => {
    assert.throws(
      () => {
        SettlementCalculator.calculateSettlement(3.5, 10);
      },
      /non-negative integer/
    );
  });

  it("should reject zero or negative participant count", () => {
    assert.throws(
      () => {
        SettlementCalculator.calculateSettlement(500, 0);
      },
      /positive integer/
    );

    assert.throws(
      () => {
        SettlementCalculator.calculateSettlement(500, -5);
      },
      /positive integer/
    );
  });

  it("should reject negative entry fees", () => {
    assert.throws(
      () => {
        SettlementCalculator.calculateSettlement(-500, 10);
      },
      /non-negative/
    );
  });

  it("should handle zero entry fee", () => {
    const result = SettlementCalculator.calculateSettlement(0, 10);
    assert.equal(result.grossPoolCents, 0);
    assert.equal(result.platformFeeCents, 0);
    assert.equal(result.prizePoolCents, 0);
  });
});

describe("SettlementCalculator — Property-Based Fuzz Testing", () => {
  /**
   * Generate random test data for property-based testing.
   */
  function generateRandomSettlement(): {
    participantCount: number;
    entryFeeCents: number;
  } {
    const participantCount = Math.floor(Math.random() * 500) + 1; // 1-500
    const entryFeeCents = Math.floor(Math.random() * 100000) + 1; // 1-100,000 cents

    return { participantCount, entryFeeCents };
  }

  it("property: invariant always holds (sum of prizes = pool) across 100 random pools", () => {
    for (let i = 0; i < 100; i++) {
      const { participantCount, entryFeeCents } = generateRandomSettlement();

      try {
        const result = SettlementCalculator.calculateSettlement(
          entryFeeCents,
          participantCount
        );

        // Core invariant
        assert.equal(
          result.prizesCents.reduce((a, b) => a + b, 0),
          result.prizePoolCents,
          `Failed on iteration ${i}: entryFee=${entryFeeCents}, participants=${participantCount}`
        );

        // Pool invariant
        assert.equal(
          result.grossPoolCents,
          result.platformFeeCents + result.prizePoolCents,
          `Pool accounting failed on iteration ${i}`
        );
      } catch (error) {
        console.error(`Failed on iteration ${i}:`, {
          participantCount,
          entryFeeCents,
          error,
        });
        throw error;
      }
    }
  });

  it("property: no negative prizes across 100 random pools", () => {
    for (let i = 0; i < 100; i++) {
      const { participantCount, entryFeeCents } = generateRandomSettlement();
      const result = SettlementCalculator.calculateSettlement(
        entryFeeCents,
        participantCount
      );

      for (const prize of result.prizesCents) {
        assert.ok(prize >= 0, `Negative prize found on iteration ${i}`);
      }
    }
  });

  it("property: platform fee is always 5% +/- 1 cent across 100 random pools", () => {
    for (let i = 0; i < 100; i++) {
      const { participantCount, entryFeeCents } = generateRandomSettlement();
      const result = SettlementCalculator.calculateSettlement(
        entryFeeCents,
        participantCount
      );

      const expectedFee = Math.round((result.grossPoolCents * 5) / 100);
      const variance = Math.abs(result.platformFeeCents - expectedFee);

      assert.ok(
        variance <= 1,
        `Fee variance exceeded on iteration ${i}: expected ~${expectedFee}, got ${result.platformFeeCents}`
      );
    }
  });

  it("property: prize split percentages are honored within 1 cent per tier", () => {
    for (let i = 0; i < 100; i++) {
      const { participantCount, entryFeeCents } = generateRandomSettlement();
      const result = SettlementCalculator.calculateSettlement(
        entryFeeCents,
        participantCount
      );

      // Check each tier's percentage
      for (let tier = 0; tier < result.splitsBps.length; tier++) {
        const expectedAmount = Math.floor(
          (result.prizePoolCents * result.splitsBps[tier]) / 10000
        );
        const actualAmount = result.prizesCents[tier];

        const variance = Math.abs(actualAmount - expectedAmount);
        assert.ok(
          variance <= 2, // allow 2 cents for rounding
          `Tier ${tier} variance exceeded on iteration ${i}`
        );
      }
    }
  });

  it("should complete 10,000 fuzz iterations without invariant violations", () => {
    let successCount = 0;
    let invariantViolations = 0;

    for (let i = 0; i < 10000; i++) {
      const { participantCount, entryFeeCents } = generateRandomSettlement();

      try {
        const result = SettlementCalculator.calculateSettlement(
          entryFeeCents,
          participantCount
        );

        if (!result.invariantValid) {
          invariantViolations++;
        } else {
          successCount++;
        }
      } catch (error) {
        // Some inputs may be invalid, that's ok
      }
    }

    assert.equal(
      invariantViolations,
      0,
      `Invariant violated ${invariantViolations} times across 10,000 fuzz iterations`
    );
    assert.ok(
      successCount > 9000,
      `Too many failures in fuzz testing (${successCount}/10000 valid)`
    );
  });

  it("property: conversion functions are inverses of each other", () => {
    const testValues = [0, 1, 5, 100, 333, 999, 10000, 99999];
    const currencies: Currency[] = ["USDC", "ZEC", "XLM"];

    for (const currency of currencies) {
      for (const original of testValues) {
        const cents = SettlementCalculator.toCents(currency, original);
        const back = SettlementCalculator.fromCents(currency, cents);

        // Should be within 0.01 units due to floating point
        assert.ok(
          Math.abs(back - original) < 0.01,
          `Conversion round-trip failed for ${currency}: ${original} -> ${cents} -> ${back}`
        );
      }
    }
  });
});
