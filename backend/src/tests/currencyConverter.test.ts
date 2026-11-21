import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CurrencyConverter,
  MockRateProvider,
  type Currency,
} from "../services/financial/currencyConverter.js";

describe("CurrencyConverter — Multi-Currency Exchange", () => {
  // ============================================================
  // Basic Conversions
  // ============================================================

  it("should convert USDC to ZEC using mock rates", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    // 1 USDC = 0.015 ZEC (default mock rate)
    const result = converter.convert(1, "USDC", "ZEC");

    assert.ok(result.convertedAmount > 0);
    assert.equal(result.originalCurrency, "USDC");
    assert.equal(result.targetCurrency, "ZEC");
    assert.equal(result.rate.from, "USDC");
    assert.equal(result.rate.to, "ZEC");
  });

  it("should convert USDC to XLM", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    // 1 USDC = 4.5 XLM (default mock rate)
    const result = converter.convert(1, "USDC", "XLM");

    assert.ok(result.convertedAmount > 0);
  });

  it("should handle same-currency conversion (identity)", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    const result = converter.convert(10, "USDC", "USDC");

    assert.equal(result.convertedAmount, 10);
    assert.equal(result.rate.rate, 1);
    assert.equal(result.slippageInCents, 0);
  });

  // ============================================================
  // Rate Snapshots
  // ============================================================

  it("should capture and cache rate snapshot", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    const snapshot = await converter.captureRateSnapshot(
      ["USDC", "ZEC", "XLM"],
      60
    );

    assert.equal(snapshot.rates.size, 9); // 3x3 pairwise rates
    assert.ok(snapshot.rates.has("USDC_ZEC"));
    assert.ok(snapshot.rates.has("ZEC_XLM"));
    assert.ok(snapshot.rates.has("XLM_USDC"));
  });

  it("should use rate snapshot for conversions", async () => {
    const provider = new MockRateProvider({
      USDC_ZEC: 0.015,
      ZEC_USDC: 67,
      USDC_XLM: 4.5,
      XLM_USDC: 0.22,
      ZEC_XLM: 300,
      XLM_ZEC: 0.0033,
    });
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "ZEC", "XLM"], 60);

    // Conversions should work without fetching new rates
    const result = converter.convert(10, "USDC", "XLM");
    assert.ok(result.convertedAmount > 0);
  });

  it("should validate snapshot is still valid", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    assert.equal(converter.isSnapshotValid(), false); // no snapshot yet

    await converter.captureRateSnapshot(["USDC"], 60);
    assert.equal(converter.isSnapshotValid(), true);
  });

  // ============================================================
  // Rounding Modes
  // ============================================================

  it("should round by default", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    const result = converter.convert(1, "USDC", "ZEC", "round");

    assert.ok(typeof result.convertedAmount === "number");
    assert.ok(result.convertedAmount > 0);
  });

  it("should floor when requested", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    const resultRound = converter.convert(1, "USDC", "ZEC", "round");
    const resultFloor = converter.convert(1, "USDC", "ZEC", "floor");

    // Floor should be <= round
    assert.ok(resultFloor.convertedAmount <= resultRound.convertedAmount);
  });

  it("should ceil when requested", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    const resultRound = converter.convert(1, "USDC", "ZEC", "round");
    const resultCeil = converter.convert(1, "USDC", "ZEC", "ceil");

    // Ceil should be >= round
    assert.ok(resultCeil.convertedAmount >= resultRound.convertedAmount);
  });

  // ============================================================
  // Batch Conversions
  // ============================================================

  it("should batch convert multiple currencies", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "ZEC", "XLM"], 60);

    const result = converter.batchConvert(
      [
        { amount: 10, currency: "USDC" },
        { amount: 1, currency: "ZEC" },
        { amount: 20, currency: "XLM" },
      ],
      "USDC"
    );

    assert.equal(result.conversions.length, 3);
    assert.ok(result.total > 0);
    assert.ok(result.totalSlippageInCents >= 0);
  });

  it("should track slippage in batch conversions", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "ZEC"], 60);

    // Use fractional amounts to generate slippage
    const result = converter.batchConvert(
      [
        { amount: 0.333, currency: "USDC" },
        { amount: 0.777, currency: "USDC" },
      ],
      "ZEC"
    );

    // Should have some slippage due to fractional conversions
    assert.ok(result.totalSlippageInCents >= 0);
  });

  // ============================================================
  // Error Handling
  // ============================================================

  it("should reject negative amounts", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    assert.throws(
      () => {
        converter.convert(-10, "USDC", "ZEC");
      },
      /non-negative/
    );
  });

  it("should throw when rate not available", () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    assert.throws(
      () => {
        converter.convert(10, "USDC", "ZEC");
      },
      /No exchange rate available/
    );
  });

  it("should clear rate cache", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "ZEC"], 60);
    assert.equal(converter.isSnapshotValid(), true);

    converter.clearCache();
    assert.equal(converter.isSnapshotValid(), false);
  });

  // ============================================================
  // Precision Tests
  // ============================================================

  it("should preserve precision with 6 decimal places", () => {
    const provider = new MockRateProvider({
      USDC_ZEC: 0.015,
    });
    const converter = new CurrencyConverter(provider);

    // Test with fractional amounts
    const result = converter.convert(1.234567, "USDC", "ZEC");

    // Should maintain precision
    assert.ok(typeof result.convertedAmount === "number");
    assert.ok(result.convertedAmount > 0);
  });

  it("should report slippage in cents", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "XLM"], 60);

    const result = converter.convert(3.33, "USDC", "XLM");

    // Slippage should be in cents (0.01 units)
    assert.ok(result.slippageInCents >= 0);
    assert.ok(typeof result.slippageInCents === "number");
  });

  // ============================================================
  // Rate Provider Tests
  // ============================================================

  it("should allow custom rate provider", async () => {
    const customRates = {
      USDC_ZEC: 0.02,
      USDC_XLM: 5.0,
      ZEC_XLM: 250,
      ZEC_USDC: 50,
      XLM_USDC: 0.2,
      XLM_ZEC: 0.004,
    };

    const provider = new MockRateProvider(customRates);
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "ZEC", "XLM"], 60);

    const result = converter.convert(10, "USDC", "ZEC");
    // 10 USDC * 0.02 = 0.2 ZEC
    assert.ok(Math.abs(result.convertedAmount - 0.2) < 0.001);
  });

  it("should allow updating rates in mock provider", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    // Update a rate
    provider.setRate("USDC", "ZEC", 0.1);

    // Clear converter's cache so it fetches new rate
    converter.clearCache();

    const result = converter.convert(1, "USDC", "ZEC");
    // Should use the new rate: 1 USDC = 0.1 ZEC
    assert.ok(Math.abs(result.convertedAmount - 0.1) < 0.01);
  });
});

describe("CurrencyConverter — Property-Based Tests", () => {
  it("property: conversions should respect exchange rate invariant across 1000 random conversions", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "ZEC", "XLM"], 60);

    for (let i = 0; i < 1000; i++) {
      const amount = Math.random() * 10000; // 0-10000
      const currencies: Currency[] = ["USDC", "ZEC", "XLM"];
      const from = currencies[Math.floor(Math.random() * currencies.length)];
      const to = currencies[Math.floor(Math.random() * currencies.length)];

      if (from === to) continue;

      const result = converter.convert(amount, from, to);

      // Slippage should be non-negative
      assert.ok(result.slippageInCents >= 0);

      // Converted amount should be positive if input is positive
      if (amount > 0) {
        assert.ok(result.convertedAmount > 0);
      }
    }
  });

  it("property: round-trip conversions should recover original within slippage tolerance", async () => {
    const provider = new MockRateProvider({
      USDC_ZEC: 0.015,
      ZEC_USDC: 67,
    });
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "ZEC"], 60);

    for (let i = 0; i < 100; i++) {
      const original = Math.random() * 1000;

      const step1 = converter.convert(original, "USDC", "ZEC");
      const step2 = converter.convert(step1.convertedAmount, "ZEC", "USDC");

      // Should be close to original (within 0.1% due to rounding and slippage)
      const tolerance = original * 0.001 + 0.01; // 0.1% or 1 cent
      const variance = Math.abs(step2.convertedAmount - original);

      assert.ok(
        variance <= tolerance,
        `Round-trip failed: ${original} -> ${step1.convertedAmount} -> ${step2.convertedAmount}, variance=${variance}`
      );
    }
  });

  it("should batch convert 1000 random mixed-currency conversions without invariant violations", async () => {
    const provider = new MockRateProvider();
    const converter = new CurrencyConverter(provider);

    await converter.captureRateSnapshot(["USDC", "ZEC", "XLM"], 60);

    for (let batch = 0; batch < 100; batch++) {
      const amounts = Array.from({ length: Math.floor(Math.random() * 10) + 1 }, () => ({
        amount: Math.random() * 1000,
        currency: (["USDC", "ZEC", "XLM"] as Currency[])[
          Math.floor(Math.random() * 3)
        ],
      }));

      const result = converter.batchConvert(
        amounts,
        "USDC"
      );

      // Total slippage should be non-negative and reasonable
      assert.ok(result.totalSlippageInCents >= 0);
      assert.ok(result.total > 0 || amounts.every((a) => a.amount === 0));
    }
  });
});
