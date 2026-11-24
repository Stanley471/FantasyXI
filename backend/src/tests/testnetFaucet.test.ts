import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  FaucetError,
  isFaucetAllowed,
  TestnetFaucetService,
  type FaucetHorizon,
} from "../services/financial/testnetFaucetService.js";
import { createFundStellarAccountHandler, devOnly } from "../routes/dev.routes.js";

const USER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4));

/** Fake Horizon that tracks accounts, trustlines and submitted operations. */
function createHorizon() {
  const accounts = new Map<string, { balances: any[] }>();
  const submitted: any[] = [];
  const horizon: FaucetHorizon = {
    async loadAccount(address) {
      const account = accounts.get(address);
      if (!account) throw new Error("not found");
      return {
        accountId: () => address,
        sequenceNumber: () => "1",
        incrementSequenceNumber() {},
        balances: account.balances,
      };
    },
    async submitTransaction(tx) {
      submitted.push(tx);
      const op = tx.operations[0];
      const target = accounts.get(tx.source);
      if (op.type === "changeTrust") {
        target!.balances.push({
          asset_code: op.line.code,
          asset_issuer: op.line.issuer,
          balance: "0.0000000",
        });
      }
      if (op.type === "payment") {
        const line = accounts.get(op.destination)!.balances.find((b) => b.asset_code === op.asset.code);
        line.balance = op.amount;
      }
      return {};
    },
  };
  const fund = (address: string) =>
    accounts.set(address, { balances: [{ asset_type: "native", balance: "10000.0000000" }] });
  accounts.set(ISSUER.publicKey(), { balances: [{ asset_type: "native", balance: "10000.0000000" }] });
  return { horizon, accounts, submitted, fund };
}

function createService(overrides: Partial<ConstructorParameters<typeof TestnetFaucetService>[0]> = {}) {
  const h = createHorizon();
  const friendbotCalls: string[] = [];
  const service = new TestnetFaucetService({
    horizon: () => h.horizon,
    fetchFn: (async (url: string) => {
      friendbotCalls.push(String(url));
      const addr = new URL(String(url)).searchParams.get("addr")!;
      h.fund(addr);
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    network: "TESTNET",
    networkPassphrase: "Test SDF Network ; September 2015",
    usdcAssetCode: "USDC",
    usdcIssuer: ISSUER.publicKey(),
    issuerSecret: ISSUER.secret(),
    ...overrides,
  });
  return { service, h, friendbotCalls };
}

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => ((res.statusCode = code), res);
  res.json = (body: unknown) => ((res.body = body), res);
  return res;
}

describe("Testnet faucet environment guard (#558)", () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it("returns 404 and never reaches the handler in production", () => {
    process.env.NODE_ENV = "production";
    const res = mockRes();
    let nextCalled = false;
    devOnly({} as any, res, () => (nextCalled = true));
    assert.equal(res.statusCode, 404);
    assert.equal(nextCalled, false);
    assert.equal(isFaucetAllowed(), false);
  });

  it("passes through in development and test", () => {
    for (const env of ["development", "test", "staging", undefined]) {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      let nextCalled = false;
      devOnly({} as any, mockRes(), () => (nextCalled = true));
      assert.equal(nextCalled, true, `NODE_ENV=${env}`);
    }
  });
});

describe("TestnetFaucetService (#558)", () => {
  it("funds a generated account, creates the USDC trustline, mints USDC and verifies on Horizon", async () => {
    const { service, friendbotCalls } = createService();
    const result = await service.fund({ generate: true });

    assert.match(result.address, /^G[A-Z2-7]{55}$/);
    assert.match(result.secret!, /^S[A-Z2-7]{55}$/);
    assert.equal(Keypair.fromSecret(result.secret!).publicKey(), result.address);
    assert.equal(result.friendbot, "funded");
    assert.equal(result.trustline, "established");
    assert.equal(result.usdcMinted, "1000.0000000");
    assert.equal(result.balances.xlm, "10000.0000000");
    assert.equal(result.balances.usdc, "1000.0000000");
    assert.equal(friendbotCalls.length, 1);
    assert.ok(friendbotCalls[0].includes(`addr=${result.address}`));
  });

  it("funds an existing address without needing its secret and reports the missing trustline", async () => {
    const { service } = createService();
    const result = await service.fund({ address: USER });
    assert.equal(result.secret, undefined);
    assert.equal(result.trustline, "requires_account_signature");
    assert.equal(result.balances.xlm, "10000.0000000");
    assert.equal(result.balances.usdc, null);
  });

  it("treats an already funded account as success", async () => {
    const { service, h } = createService({
      fetchFn: (async () =>
        new Response('{"detail":"createAccountAlreadyExist"}', { status: 400 })) as typeof fetch,
    });
    h.fund(USER);
    const result = await service.fund({ address: USER });
    assert.equal(result.friendbot, "already_funded");
  });

  it("skips trustline and mint when the USDC issuer is a contract address", async () => {
    const { service } = createService({ usdcIssuer: "C" + "A".repeat(55), issuerSecret: undefined });
    const result = await service.fund({ generate: true });
    assert.equal(result.trustline, "not_configured");
    assert.equal(result.usdcMinted, null);
    assert.equal(result.balances.usdc, null);
  });

  it("does not mint when the issuer secret does not match the configured issuer", async () => {
    const { service } = createService({ issuerSecret: Keypair.random().secret() });
    const result = await service.fund({ generate: true });
    assert.equal(result.trustline, "established");
    assert.equal(result.usdcMinted, null);
  });

  it("rejects invalid addresses, non-testnet networks and Friendbot failures", async () => {
    const { service } = createService();
    await assert.rejects(() => service.fund({ address: "nope" }), (e: any) => e instanceof FaucetError && e.status === 400);
    await assert.rejects(() => service.fund({}), (e: any) => e.status === 400);

    const mainnet = createService({ network: "PUBLIC" }).service;
    await assert.rejects(() => mainnet.fund({ generate: true }), (e: any) => e.status === 400);

    const down = createService({ fetchFn: (async () => new Response("boom", { status: 500 })) as typeof fetch }).service;
    await assert.rejects(() => down.fund({ address: USER }), (e: any) => e.status === 502);

    const unreachable = createService({
      fetchFn: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    }).service;
    await assert.rejects(() => unreachable.fund({ address: USER }), (e: any) => e.status === 502);
  });
});

describe("POST /api/dev/fund-stellar-account handler (#558)", () => {
  it("returns the faucet result", async () => {
    const { service } = createService();
    const res = mockRes();
    await createFundStellarAccountHandler(async () => service)({ body: { address: USER } } as any, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.address, USER);
  });

  it("maps faucet errors to their status and hides unexpected errors", async () => {
    const { service } = createService();
    const bad = mockRes();
    await createFundStellarAccountHandler(async () => service)({ body: {} } as any, bad);
    assert.equal(bad.statusCode, 400);

    const broken = mockRes();
    await createFundStellarAccountHandler(async () => {
      throw new Error("secret internal detail");
    })({ body: {} } as any, broken);
    assert.equal(broken.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(broken.body), /secret internal detail/);
  });
});
