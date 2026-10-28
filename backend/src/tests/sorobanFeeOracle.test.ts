import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, SorobanDataBuilder, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import {
  FEE_ORACLE_DEFAULTS,
  SorobanFeeOracle,
  type FeeStatsSource,
} from "../services/financial/sorobanFeeOracle.js";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 3));

function feeStats(p90: number, transactionCount = 50): rpc.Api.GetFeeStatsResponse {
  const distribution = {
    max: String(p90 * 2),
    min: "100",
    mode: "100",
    p10: "100",
    p20: "100",
    p30: "100",
    p40: "100",
    p50: "100",
    p60: "100",
    p70: "100",
    p80: "100",
    p90: String(p90),
    p95: String(p90),
    p99: String(p90),
    transactionCount: String(transactionCount),
    ledgerCount: 50,
  };
  return { sorobanInclusionFee: distribution, inclusionFee: distribution, latestLedger: 1000 };
}

/** RPC mock replaying a scripted fee series; `null` entries simulate RPC outages. */
function scriptedSource(series: Array<number | null>) {
  const source = {
    calls: 0,
    async getFeeStats() {
      const next = series[Math.min(source.calls++, series.length - 1)];
      if (next === null) throw new Error("RPC unavailable");
      return feeStats(next);
    },
  };
  return source;
}

function clock(start = 0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

describe("SorobanFeeOracle", () => {
  it("escalates quickly into a surge and decays slowly afterwards", async () => {
    const time = clock();
    const series = [100, 100, 100, 5_000, 20_000, 20_000, 300, 300, 300, 300];
    const oracle = new SorobanFeeOracle(scriptedSource(series), {
      now: time.now,
      refreshIntervalMs: 1_000,
      headroom: 1,
    });

    const estimates: number[] = [];
    for (let i = 0; i < series.length; i++) {
      estimates.push(Number(await oracle.estimateInclusionFee()));
      time.advance(1_000);
    }

    assert.deepEqual(estimates.slice(0, 3), [100, 100, 100]);
    // Surge: each spike sample pushes the estimate up by at least 60% of the gap.
    assert.ok(estimates[3] >= 100 + 0.6 * (5_000 - 100));
    assert.ok(estimates[4] > estimates[3] && estimates[5] > estimates[4]);
    assert.ok(estimates[5] >= 0.85 * 20_000);
    // Decay: the estimate falls monotonically but stays above the calm level.
    for (let i = 7; i < estimates.length; i++) {
      assert.ok(estimates[i] < estimates[i - 1]);
    }
    assert.ok(estimates[estimates.length - 1] > 300 * 2);
  });

  it("keeps every estimate within min/max bounds across a volatile series", async () => {
    const time = clock();
    const series = Array.from({ length: 200 }, (_, i) =>
      i % 17 === 0 ? 50_000_000 : 100 + ((i * 7919) % 40_000)
    );
    const oracle = new SorobanFeeOracle(scriptedSource(series), {
      now: time.now,
      refreshIntervalMs: 0,
      minFee: 200,
      maxFee: 250_000,
    });

    for (let i = 0; i < series.length; i++) {
      const fee = Number(await oracle.estimateInclusionFee());
      assert.ok(fee >= 200 && fee <= 250_000, `estimate ${fee} out of bounds`);
      time.advance(10);
    }
  });

  it("applies the headroom multiplier on top of the smoothed fee", () => {
    const oracle = new SorobanFeeOracle(scriptedSource([]), { headroom: 1.5, now: () => 0 });
    oracle.observe(1_000);
    assert.equal(oracle.currentEstimate(), 1_500);
  });

  it("falls back to the conservative default before any telemetry and on RPC failure", async () => {
    const time = clock();
    const source = scriptedSource([null]);
    const oracle = new SorobanFeeOracle(source, { now: time.now });

    assert.equal(oracle.currentEstimate(), FEE_ORACLE_DEFAULTS.fallbackFee);
    assert.equal(await oracle.estimateInclusionFee(), String(FEE_ORACLE_DEFAULTS.fallbackFee));
    assert.equal(source.calls, 1);
  });

  it("falls back once telemetry goes stale and recovers on a fresh sample", async () => {
    const time = clock();
    const source = scriptedSource([400, null, null, 400]);
    const oracle = new SorobanFeeOracle(source, {
      now: time.now,
      refreshIntervalMs: 1_000,
      staleAfterMs: 5_000,
      headroom: 1,
    });

    assert.equal(await oracle.estimateInclusionFee(), "400");
    time.advance(2_000);
    // One failed poll does not discard still-fresh telemetry.
    assert.equal(await oracle.estimateInclusionFee(), "400");
    time.advance(4_000);
    assert.equal(await oracle.estimateInclusionFee(), String(FEE_ORACLE_DEFAULTS.fallbackFee));
    time.advance(1_000);
    assert.equal(await oracle.estimateInclusionFee(), "400");
  });

  it("treats an idle network as the minimum fee", async () => {
    const source: FeeStatsSource = { getFeeStats: async () => feeStats(9_999, 0) };
    const oracle = new SorobanFeeOracle(source, { now: () => 0, headroom: 1 });
    assert.equal(await oracle.estimateInclusionFee(), String(FEE_ORACLE_DEFAULTS.minFee));
  });

  it("rate-limits RPC polling to the refresh interval", async () => {
    const time = clock();
    const source = scriptedSource([500]);
    const oracle = new SorobanFeeOracle(source, { now: time.now, refreshIntervalMs: 5_000 });

    await Promise.all([oracle.estimateInclusionFee(), oracle.estimateInclusionFee()]);
    time.advance(4_999);
    await oracle.estimateInclusionFee();
    assert.equal(source.calls, 1);
    time.advance(1);
    await oracle.estimateInclusionFee();
    assert.equal(source.calls, 2);
  });
});

describe("SorobanContractClient fee oracle integration", () => {
  function mockServer(feeSeries: Array<number | null>) {
    const fees = scriptedSource(feeSeries);
    const builtFees: string[] = [];
    const server: any = {
      getFeeStats: fees.getFeeStats,
      getAccount: async (pub: string) => new Account(pub, "1"),
      simulateTransaction: async (tx: any) => {
        builtFees.push(tx.fee);
        return {
          _parsed: true,
          id: "1",
          latestLedger: 100,
          events: [],
          minResourceFee: "0",
          transactionData: new SorobanDataBuilder(),
          result: { auth: [], retval: xdr.ScVal.scvVoid() },
        };
      },
      sendTransaction: async () => ({ status: "PENDING", hash: "a".repeat(64) }),
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
      getLatestLedger: async () => ({ sequence: 100 }),
    };
    return { server, builtFees };
  }

  it("prices contract invocations from live fee telemetry during a surge", async () => {
    const { server, builtFees } = mockServer([30_000]);
    const client = new SorobanContractClient({
      server,
      escrowContractId: CONTRACT_ID,
      pollIntervalMs: 1,
      feeOracle: new SorobanFeeOracle(server, { headroom: 1 }),
    });
    const admin = Keypair.random();

    const res = await client.deposit(admin.secret(), admin.publicKey(), 1);
    assert.equal(res.success, true);
    assert.deepEqual(builtFees, ["30000"]);
  });

  it("uses the conservative fallback when fee telemetry is unavailable", async () => {
    const { server, builtFees } = mockServer([null]);
    const client = new SorobanContractClient({
      server,
      escrowContractId: CONTRACT_ID,
      pollIntervalMs: 1,
    });
    const admin = Keypair.random();

    const res = await client.deposit(admin.secret(), admin.publicKey(), 1);
    assert.equal(res.success, true);
    assert.deepEqual(builtFees, [String(FEE_ORACLE_DEFAULTS.fallbackFee)]);
  });
});
