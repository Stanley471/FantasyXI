import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Account, Asset, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  PATH_PAYMENT_QUOTE_TTL_SECONDS,
  PathPaymentError,
  StellarService,
  type PathPaymentQuote,
} from "../services/financial/stellarService.js";
import { DepositVerificationService } from "../services/financial/depositVerificationService.js";
import { stellarConfig } from "../config/stellar.js";

const DEPOSITOR = Keypair.random();
const ESCROW = Keypair.random().publicKey();
const ESCROW_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const USDC = new Asset("USDC", Keypair.random().publicKey());
const EURC = new Asset("EURC", Keypair.random().publicKey());
const XLM = Asset.native();
const NOW = 1_800_000_000;

function pathRecord(sourceAmount: string, path: Asset[] = [], source: Asset = XLM) {
  return {
    source_amount: sourceAmount,
    source_asset_type: source.isNative() ? "native" : "credit_alphanum4",
    source_asset_code: source.isNative() ? undefined : source.getCode(),
    source_asset_issuer: source.isNative() ? undefined : source.getIssuer(),
    destination_amount: "25.0000000",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: USDC.getCode(),
    destination_asset_issuer: USDC.getIssuer(),
    path: path.map((asset) => ({
      asset_type: asset.isNative() ? "native" : "credit_alphanum4",
      asset_code: asset.isNative() ? undefined : asset.getCode(),
      asset_issuer: asset.isNative() ? undefined : asset.getIssuer(),
    })),
  };
}

function mockHorizon(options: {
  receivePaths?: unknown[];
  sendPaths?: unknown[];
  submit?: () => Promise<unknown>;
  lookup?: () => Promise<unknown>;
} = {}) {
  const calls: { receivePaths: unknown[][] } = { receivePaths: [] };
  const server: any = {
    calls,
    strictReceivePaths: (...args: unknown[]) => {
      calls.receivePaths.push(args);
      return { call: async () => ({ records: options.receivePaths ?? [] }) };
    },
    strictSendPaths: () => ({ call: async () => ({ records: options.sendPaths ?? [] }) }),
    loadAccount: async (id: string) => new Account(id, "41"),
    submitTransaction: options.submit ?? (async () => ({ hash: "f".repeat(64), ledger: 77 })),
    transactions: () => ({
      transaction: () => ({ call: options.lookup ?? (async () => Promise.reject(new Error("404"))) }),
    }),
  };
  return server;
}

async function quote(server: any, extra: Partial<Parameters<StellarService["quoteEntryFeePathPayment"]>[0]> = {}) {
  return new StellarService(server).quoteEntryFeePathPayment({
    sendAsset: XLM,
    destAsset: USDC,
    destAmount: "25",
    now: NOW,
    ...extra,
  });
}

function decode(envelopeXdr: string) {
  return TransactionBuilder.fromXDR(envelopeXdr, stellarConfig.networkPassphrase) as any;
}

const rejection = (transaction: string, operations: string[]) =>
  Promise.reject({ response: { data: { extras: { result_codes: { transaction, operations } } } } });

describe("path payment quotes", () => {
  it("selects the cheapest path and caps the spend with slippage", async () => {
    const server = mockHorizon({
      receivePaths: [
        pathRecord("130.1000000", [EURC]),
        pathRecord("125.0000001", []),
        pathRecord("127.5000000", [EURC, USDC]),
        pathRecord("1.0000000", [], EURC), // different source asset: ignored
      ],
    });
    const result = await quote(server, { slippageBps: 100 });

    assert.equal(result.sourceAmount, "125.0000001");
    // 125.0000001 * 1.01 = 126.250000101 -> rounded up to the next stroop
    assert.equal(result.sendMax, "126.2500002");
    assert.equal(result.destAmount, "25.0000000");
    assert.deepEqual(result.path, []);
    assert.equal(result.expiresAt, NOW + PATH_PAYMENT_QUOTE_TTL_SECONDS);
    assert.equal(server.calls.receivePaths[0][2], "25");
  });

  it("maps intermediate hops and allows zero slippage", async () => {
    const server = mockHorizon({ receivePaths: [pathRecord("99.0000000", [EURC])] });
    const result = await quote(server, { slippageBps: 0 });
    assert.equal(result.sendMax, "99.0000000");
    assert.ok(result.path[0].equals(EURC));
  });

  it("rejects out-of-range slippage, bad amounts and missing liquidity", async () => {
    const server = mockHorizon({ receivePaths: [pathRecord("1.0000000")] });
    for (const slippageBps of [-1, 501, 1.5, Number.NaN]) {
      await assert.rejects(quote(server, { slippageBps }), (e: unknown) =>
        e instanceof PathPaymentError && e.code === "INVALID_SLIPPAGE"
      );
    }
    for (const destAmount of ["0", "-5", "abc", "1.12345678"]) {
      await assert.rejects(quote(server, { destAmount }), (e: unknown) =>
        e instanceof PathPaymentError && e.code === "INVALID_AMOUNT"
      );
    }
    await assert.rejects(quote(mockHorizon({ receivePaths: [] })), (e: unknown) =>
      e instanceof PathPaymentError && e.code === "NO_PATH"
    );
  });
});

describe("path payment envelopes", () => {
  async function freshQuote(): Promise<PathPaymentQuote> {
    return quote(mockHorizon({ receivePaths: [pathRecord("125.0000000", [EURC])] }), { slippageBps: 50 });
  }

  it("builds a single atomic strict-receive operation into the escrow account", async () => {
    const q = await freshQuote();
    const envelope = await new StellarService(mockHorizon()).buildPathPaymentEnvelope({
      sourceAccount: DEPOSITOR.publicKey(),
      quote: q,
      destination: ESCROW,
      memo: "LEAGUE-7",
      now: NOW,
    });
    const tx = decode(envelope.xdr);

    assert.equal(envelope.settlesIntoEscrow, true);
    assert.equal(tx.operations.length, 1);
    const [op] = tx.operations;
    assert.equal(op.type, "pathPaymentStrictReceive");
    assert.equal(op.destination, ESCROW);
    assert.equal(op.destAmount, "25.0000000");
    assert.equal(op.sendMax, "125.6250000");
    assert.ok(op.destAsset.equals(USDC));
    assert.ok(op.path[0].equals(EURC));
    assert.equal(Number(tx.timeBounds.maxTime), q.expiresAt);
    assert.equal(Buffer.from(tx.memo.value).toString(), "LEAGUE-7");
  });

  it("routes the swap to the depositor when the escrow is a Soroban contract", async () => {
    const envelope = await new StellarService(mockHorizon()).buildPathPaymentEnvelope({
      sourceAccount: DEPOSITOR.publicKey(),
      quote: await freshQuote(),
      destination: ESCROW_CONTRACT,
      now: NOW,
    });
    assert.equal(envelope.settlesIntoEscrow, false);
    assert.equal(decode(envelope.xdr).operations[0].destination, DEPOSITOR.publicKey());
  });

  it("refuses to build from an expired quote", async () => {
    const q = await freshQuote();
    await assert.rejects(
      new StellarService(mockHorizon()).buildPathPaymentEnvelope({
        sourceAccount: DEPOSITOR.publicKey(),
        quote: q,
        destination: ESCROW,
        now: q.expiresAt,
      }),
      (e: unknown) => e instanceof PathPaymentError && e.code === "QUOTE_EXPIRED"
    );
  });

  it("builds a strict-send refund swap back into the original asset", async () => {
    const server = mockHorizon({
      sendPaths: [
        { ...pathRecord("0"), destination_amount: "120.0000000", destination_asset_type: "native", path: [] },
        { ...pathRecord("0"), destination_amount: "123.0000000", destination_asset_type: "native", path: [] },
      ],
    });
    const envelope = await new StellarService(server).buildPathPaymentRefundEnvelope({
      sourceAccount: DEPOSITOR.publicKey(),
      quote: await freshQuote(),
      slippageBps: 100,
      now: NOW,
    });
    const [op] = decode(envelope.xdr).operations;
    assert.equal(op.type, "pathPaymentStrictSend");
    assert.equal(op.destination, DEPOSITOR.publicKey());
    assert.equal(op.sendAmount, "25.0000000");
    assert.ok(op.sendAsset.equals(USDC));
    assert.ok(op.destAsset.equals(XLM));
    // Best path returns 123 XLM; 1% slippage floor.
    assert.equal(op.destMin, "121.7700000");
  });
});

describe("path payment submission", () => {
  async function signedEnvelope(): Promise<string> {
    const q = await quote(mockHorizon({ receivePaths: [pathRecord("125.0000000")] }));
    const { xdr } = await new StellarService(mockHorizon()).buildPathPaymentEnvelope({
      sourceAccount: DEPOSITOR.publicKey(),
      quote: q,
      destination: ESCROW,
      now: NOW,
    });
    const tx = decode(xdr);
    tx.sign(DEPOSITOR);
    return tx.toXDR();
  }

  it("reports a settled swap", async () => {
    const result = await new StellarService(mockHorizon()).submitPathPayment(await signedEnvelope());
    assert.deepEqual(result, { status: "SETTLED", txHash: "f".repeat(64), ledger: 77 });
  });

  it("aborts cleanly with a re-quote hint when the price moves past sendMax", async () => {
    const server = mockHorizon({ submit: () => rejection("tx_failed", ["op_over_source_max"]) });
    const result = await new StellarService(server).submitPathPayment(await signedEnvelope());
    assert.equal(result.status, "ABORTED");
    if (result.status === "ABORTED") {
      assert.equal(result.retryable, true);
      assert.equal(result.fundsMoved, false);
      assert.equal(result.reason, "op_over_source_max");
    }
  });

  it("aborts without retry for underfunded accounts", async () => {
    const server = mockHorizon({ submit: () => rejection("tx_failed", ["op_underfunded"]) });
    const result = await new StellarService(server).submitPathPayment(await signedEnvelope());
    assert.equal(result.status, "ABORTED");
    if (result.status === "ABORTED") assert.equal(result.retryable, false);
  });

  it("treats an expired envelope as a retryable abort", async () => {
    const server = mockHorizon({ submit: () => rejection("tx_too_late", []) });
    const result = await new StellarService(server).submitPathPayment(await signedEnvelope());
    assert.equal(result.status, "ABORTED");
    if (result.status === "ABORTED") assert.equal(result.retryable, true);
  });

  it("resolves ambiguous network failures by looking up the hash", async () => {
    const timeout = () => Promise.reject(new Error("socket hang up"));
    const settled = mockHorizon({
      submit: timeout,
      lookup: async () => ({ successful: true, ledger_attr: 90 }),
    });
    const settledResult = await new StellarService(settled).submitPathPayment(await signedEnvelope());
    assert.equal(settledResult.status, "SETTLED");

    const unknown = mockHorizon({ submit: timeout });
    const pending = await new StellarService(unknown).submitPathPayment(await signedEnvelope());
    assert.equal(pending.status, "PENDING");
    if (pending.status === "PENDING") assert.equal(pending.expiresAt, NOW + PATH_PAYMENT_QUOTE_TTL_SECONDS);
  });
});

describe("path payment deposit verification", () => {
  it("verifies a DEX-routed deposit by its delivered amount", async () => {
    const server: any = {
      transactions: () => ({
        transaction: () => ({
          call: async () => ({
            hash: "a".repeat(64),
            successful: true,
            ledger_attr: 1000,
            created_at: "2026-09-25T12:00:00Z",
            source_account: DEPOSITOR.publicKey(),
          }),
        }),
      }),
      operations: () => ({
        forTransaction: () => ({
          call: async () => ({
            records: [
              {
                type: "path_payment_strict_receive",
                from: DEPOSITOR.publicKey(),
                to: ESCROW,
                amount: "25.0000000",
                asset_type: "credit_alphanum4",
                asset_code: USDC.getCode(),
                asset_issuer: USDC.getIssuer(),
                source_amount: "125.0000000",
                source_asset_type: "native",
              },
            ],
          }),
        }),
      }),
    };
    const result = await new DepositVerificationService(server).verifyDeposit({
      txHash: "a".repeat(64),
      expectedDestination: ESCROW,
      expectedAmount: 25,
      expectedSender: DEPOSITOR.publicKey(),
      expectedAssetCode: USDC.getCode(),
      expectedAssetIssuer: USDC.getIssuer(),
    });
    assert.equal(result.verified, true);
  });
});
