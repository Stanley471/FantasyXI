import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MultiAssetSettlement,
  Participant,
} from "../services/financial/multiAssetSettlement.js";
import {
  CurrencyConverter,
  MockRateProvider,
} from "../services/financial/currencyConverter.js";
import { SettlementCalculator } from "../services/financial/settlementCalculator.js";

describe("MultiAssetSettlement — Multi-Currency Prize Distribution", () => {
  // ============================================================
  // Settlement Plan Creation
  // ============================================================

  it("should create a settlement plan for homogeneous participants", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CI...",
      },
      {
        id: "user2",
        rank: 2,
        score: 95,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CJ...",
      },
      {
        id: "user3",
        rank: 3,
        score: 90,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CK...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-1",
      500, // $5 entry fee
      participants
    );

    assert.equal(plan.leagueId, "league-1");
    assert.equal(plan.participants.length, 3);
    assert.equal(plan.referenceCurrency, "USDC");
    assert.ok(plan.grossPoolCents > 0);
    assert.ok(plan.prizePoolCents > 0);
  });

  it("should create a settlement plan for mixed-currency participants", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CI...",
      },
      {
        id: "user2",
        rank: 2,
        score: 95,
        preferredCurrency: "ZEC",
        stellarAddress: "GBRPYHIL2CJ...",
      },
      {
        id: "user3",
        rank: 3,
        score: 90,
        preferredCurrency: "XLM",
        stellarAddress: "GBRPYHIL2CK...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-2",
      1000, // $10 entry fee
      participants,
      "USDC"
    );

    assert.equal(plan.participants.length, 3);
    assert.ok(plan.participants.some((p) => p.preferredCurrency === "ZEC"));
    assert.ok(plan.participants.some((p) => p.preferredCurrency === "XLM"));
  });

  // ============================================================
  // Settlement Execution
  // ============================================================

  it("should execute settlement with single-currency participants", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CI...",
      },
      {
        id: "user2",
        rank: 2,
        score: 95,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CJ...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-1",
      1000, // $10
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);

    assert.equal(result.leagueId, "league-1");
    assert.equal(result.entries.length, 2);
    assert.ok(result.invariantValid);
    assert.ok(result.totalParticipants > 0);
  });

  it("should execute settlement with mixed-currency participants", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CI...",
      },
      {
        id: "user2",
        rank: 2,
        score: 95,
        preferredCurrency: "ZEC",
        stellarAddress: "GBRPYHIL2CJ...",
      },
      {
        id: "user3",
        rank: 3,
        score: 90,
        preferredCurrency: "XLM",
        stellarAddress: "GBRPYHIL2CK...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-2",
      500,
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);

    assert.equal(result.entries.length, 3);
    assert.ok(
      result.entries.some((e) => e.preferredCurrency === "USDC")
    );
    assert.ok(
      result.entries.some((e) => e.preferredCurrency === "ZEC")
    );
    assert.ok(
      result.entries.some((e) => e.preferredCurrency === "XLM")
    );
  });

  // ============================================================
  // Settlement Grouping by Currency
  // ============================================================

  it("should group settlement entries by currency", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CI...",
      },
      {
        id: "user2",
        rank: 2,
        score: 95,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CJ...",
      },
      {
        id: "user3",
        rank: 3,
        score: 90,
        preferredCurrency: "ZEC",
        stellarAddress: "GBRPYHIL2CK...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-3",
      1000,
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);
    const grouped = settlement.groupSettlementByCurrency(result);

    assert.ok(grouped.has("USDC"));
    assert.ok(grouped.has("ZEC"));
    assert.equal(grouped.get("USDC")!.entries.length, 2);
    assert.equal(grouped.get("ZEC")!.entries.length, 1);
  });

  // ============================================================
  // Settlement Validation
  // ============================================================

  it("should validate settlement with valid entries", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CI...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-4",
      1000,
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);
    const validation = settlement.validateSettlement(result);

    assert.equal(validation.valid, true);
    assert.equal(validation.errors.length, 0);
  });

  it("should detect invalid stellar addresses", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "INVALID", // too short
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-5",
      1000,
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);
    const validation = settlement.validateSettlement(result);

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => e.includes("stellar address")));
  });

  // ============================================================
  // Slippage Tracking
  // ============================================================

  it("should track total slippage in multi-currency settlement", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        preferredCurrency: "ZEC",
        rank: 1,
        score: 100,
        stellarAddress: "GBRPYHIL2CI...",
      },
      {
        id: "user2",
        preferredCurrency: "XLM",
        rank: 2,
        score: 95,
        stellarAddress: "GBRPYHIL2CJ...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-6",
      333, // Use odd amount to generate rounding
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);

    // Slippage should be tracked
    assert.ok(result.totalSlippageCents >= 0);
  });

  // ============================================================
  // Audit Trail
  // ============================================================

  it("should generate audit trail", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CI...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-7",
      1000,
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);
    const auditTrail = settlement.generateAuditTrail(result);

    assert.ok(auditTrail.includes("League ID: league-7"));
    assert.ok(auditTrail.includes("Settlement Time"));
    assert.ok(auditTrail.includes("Platform Fee"));
    assert.ok(auditTrail.includes("Payouts"));
  });

  // ============================================================
  // Edge Cases
  // ============================================================

  it("should reject empty participant list", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    assert.throws(
      () => {
        settlement.createSettlementPlan("league-8", 1000, []);
      },
      /at least one participant/
    );
  });

  it("should handle single-participant settlement", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    const participants: Participant[] = [
      {
        id: "user1",
        rank: 1,
        score: 100,
        preferredCurrency: "USDC",
        stellarAddress: "GBRPYHIL2CI...",
      },
    ];

    const plan = settlement.createSettlementPlan(
      "league-9",
      1000,
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].participantId, "user1");
    assert.equal(result.entries[0].participantRank, 1);
  });

  it("should calculate correct distribution for 10-player league", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);
    const settlement = new MultiAssetSettlement(converter);

    // Create 10 participants
    const participants: Participant[] = Array.from({ length: 10 }, (_, i) => ({
      id: `user${i + 1}`,
      rank: i + 1,
      score: 100 - i * 5,
      preferredCurrency: "USDC",
      stellarAddress: `GBRPYHIL2C${String.fromCharCode(65 + i)}...`,
    }));

    const plan = settlement.createSettlementPlan(
      "league-10",
      500, // $5 per person
      participants,
      "USDC"
    );

    const result = await settlement.executeSettlement(plan);

    // Verify 60/30/10 split
    assert.equal(result.entries.length, 10);
    assert.ok(result.invariantValid);

    // First place should get ~60% of pool
    const firstAmount =
      result.entries[0].prizeAmountInReferenceCurrency;
    const totalPrize = result.entries.reduce(
      (sum, e) => sum + e.prizeAmountInReferenceCurrency,
      0
    );

    const firstPercentage = firstAmount / totalPrize;
    assert.ok(Math.abs(firstPercentage - 0.6) < 0.05); // within 5%
  });
});

describe("MultiAssetSettlement — Property-Based Tests", () => {
  it("property: settlement invariant holds across 100 random participant pools", async () => {
    for (let i = 0; i < 100; i++) {
      const participantCount = Math.floor(Math.random() * 50) + 1; // 1-50 participants
      const entryFeeCents = Math.floor(Math.random() * 10000) + 100; // 100-10000 cents

      const provider = new MockRateProvider();
      const converter = new CurrencyConverter(provider);
      const settlement = new MultiAssetSettlement(converter);

      const participants: Participant[] = Array.from(
        { length: participantCount },
        (_, idx) => ({
          id: `user${idx + 1}`,
          rank: idx + 1,
          score: 100 - idx,
          preferredCurrency: (["USDC", "ZEC", "XLM"] as const)[
            idx % 3
          ],
          stellarAddress: `GBRPYHIL2C${String(idx).padStart(3, "0")}`,
        })
      );

      const plan = settlement.createSettlementPlan(
        `league-${i}`,
        entryFeeCents,
        participants,
        "USDC"
      );

      const result = await settlement.executeSettlement(plan);

      assert.ok(result.invariantValid, `Iteration ${i}: invariant failed`);
      assert.equal(
        result.entries.length,
        participantCount,
        `Iteration ${i}: entry count mismatch`
      );
    }
  });

  it("property: no duplicate participants in settlement across 100 iterations", async () => {
    for (let i = 0; i < 100; i++) {
      const participantCount = Math.floor(Math.random() * 30) + 1;

      const provider = new MockRateProvider();
      const converter = new CurrencyConverter(provider);
      const settlement = new MultiAssetSettlement(converter);

      const participants: Participant[] = Array.from(
        { length: participantCount },
        (_, idx) => ({
          id: `user${idx}`,
          rank: idx + 1,
          score: 100 - idx,
          preferredCurrency: "USDC",
          stellarAddress: `GBRPYHIL2C${String(idx).padStart(3, "0")}`,
        })
      );

      const plan = settlement.createSettlementPlan(
        `league-dup-${i}`,
        500,
        participants,
        "USDC"
      );

      const result = await settlement.executeSettlement(plan);

      const ids = result.entries.map((e) => e.participantId);
      const uniqueIds = new Set(ids);

      assert.equal(uniqueIds.size, ids.length, `Iteration ${i}: duplicate entries found`);
    }
  });

  it("property: all payouts are non-negative across 100 random settlements", async () => {
    for (let i = 0; i < 100; i++) {
      const participantCount = Math.floor(Math.random() * 50) + 1;

      const provider = new MockRateProvider();
      const converter = new CurrencyConverter(provider);
      const settlement = new MultiAssetSettlement(converter);

      const participants: Participant[] = Array.from(
        { length: participantCount },
        (_, idx) => ({
          id: `user${idx}`,
          rank: idx + 1,
          score: 100 - idx,
          preferredCurrency: (["USDC", "ZEC", "XLM"] as const)[
            idx % 3
          ],
          stellarAddress: `GBRPYHIL2C${String(idx).padStart(3, "0")}`,
        })
      );

      const plan = settlement.createSettlementPlan(
        `league-nonneg-${i}`,
        Math.floor(Math.random() * 5000) + 100,
        participants,
        "USDC"
      );

      const result = await settlement.executeSettlement(plan);

      for (const entry of result.entries) {
        assert.ok(
          entry.convertedAmount >= 0,
          `Iteration ${i}: negative payout found`
        );
        assert.ok(
          entry.prizeAmountInReferenceCurrency >= 0,
          `Iteration ${i}: negative prize found`
        );
      }
    }
  });
});
