import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";
import { MemorySorobanReplayStore } from "./helpers/sorobanReplayStore.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const admin = Keypair.random();

function successSimulation(retval: xdr.ScVal = xdr.ScVal.scvVoid()) {
  return {
    _parsed: true,
    id: "1",
    latestLedger: 100,
    events: [],
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder(),
    result: { auth: [], retval },
  };
}

function createMockServer(simulations: any[]) {
  const calls = { hashes: [] as string[], simulate: 0, send: [] as string[], getTransaction: 0 };
  const server: any = {
    calls,
    getAccount: async (pub: string) => new Account(pub, "1"),
    simulateTransaction: async () => simulations[calls.simulate++],
    sendTransaction: async (tx: any) => {
      calls.send.push(tx.operations[0].type);
      return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex") };
      calls.hashes.push(Buffer.from(tx.hash()).toString("hex"));
      return { status: "PENDING", hash: calls.hashes.at(-1) };
    },
    getTransaction: async () =>
      ++calls.getTransaction % 2 === 1
        ? {
            status: rpc.Api.GetTransactionStatus.NOT_FOUND,
            latestLedgerCloseTime: Math.floor(Date.now() / 1000),
          }
        : {
            status: rpc.Api.GetTransactionStatus.SUCCESS,
            ledger: 101,
            returnValue: nativeToScVal(42, { type: "u32" }),
          },
  };
  return server;
}

function createClient(server: any) {
  return new SorobanContractClient({
    server,
    escrowContractId: CONTRACT_ID,
    usdcContractId: CONTRACT_ID,
    pollIntervalMs: 1,
    replayStore: new MemorySorobanReplayStore(),
  });
}

describe("SorobanContractClient RPC pipeline", () => {
  it("simulates, assembles, signs, sends and polls until confirmed", async () => {
    const server = createMockServer([successSimulation()]);
    const res = await createClient(server).createLeague(admin.secret(), admin.publicKey(), 7, 10n);

    assert.equal(res.success, true);
    assert.equal(res.txHash?.length, 64);
    assert.equal(res.txHash, server.calls.hashes[0]);
    assert.equal(res.returnValue, 42);
    assert.deepEqual(server.calls.send, ["invokeHostFunction", "invokeHostFunction"]);
    assert.equal(server.calls.getTransaction, 2);
  });

  it("restores an archived footprint before invoking", async () => {
    const restore = {
      ...successSimulation(),
      restorePreamble: { minResourceFee: "500", transactionData: new SorobanDataBuilder() },
    };
    const server = createMockServer([restore, successSimulation()]);
    const res = await createClient(server).deposit(admin.secret(), admin.publicKey(), 7);

    assert.equal(res.success, true);
    assert.deepEqual(server.calls.send, [
      "restoreFootprint",
      "restoreFootprint",
      "invokeHostFunction",
      "invokeHostFunction",
    ]);
    assert.equal(server.calls.simulate, 2);
  });

  it("returns the contract error code when simulation fails", async () => {
    const server = createMockServer([
      { id: "1", latestLedger: 100, events: [], _parsed: true, error: "HostError: Error(Contract, #6)" },
    ]);
    const res = await createClient(server).deposit(admin.secret(), admin.publicKey(), 7);

    assert.equal(res.success, false);
    assert.equal(res.contractErrorCode, 6);
    assert.deepEqual(server.calls.send, []);
  });

  it("decodes read-only results without submitting", async () => {
    const state = nativeToScVal({
      creator: admin.publicKey(),
      entry_fee: nativeToScVal(10n, { type: "i128" }),
      participant_count: nativeToScVal(2, { type: "u32" }),
      status: nativeToScVal(0, { type: "u32" }),
      total_deposited: nativeToScVal(20n, { type: "i128" }),
    });
    const server = createMockServer([successSimulation(state), successSimulation()]);
    const client = createClient(server);

    assert.deepEqual(await client.getLeague(7), {
      creator: admin.publicKey(),
      entry_fee: 10n,
      participant_count: 2,
      status: 0,
      total_deposited: 20n,
      token_address: undefined,
      asset: undefined,
    });
    assert.equal(await client.getLeague(8), null);
    assert.deepEqual(server.calls.send, []);
  });

  it("returns a true zero balance but rejects failed or empty audit reads", async () => {
    const zeroBalance = createClient(
      createMockServer([successSimulation(nativeToScVal(0n, { type: "i128" }))])
    );
    assert.equal(await zeroBalance.getTokenBalanceForAudit(admin.publicKey()), 0n);

    const failedRead = createClient(
      createMockServer([
        { id: "1", latestLedger: 100, events: [], _parsed: true, error: "RPC simulation failed" },
      ])
    );
    await assert.rejects(
      () => failedRead.getTokenBalanceForAudit(admin.publicKey()),
      /Unable to audit token balance/
    );

    const emptyRead = createClient(createMockServer([successSimulation()]));
    await assert.rejects(
      () => emptyRead.getTokenBalanceForAudit(admin.publicKey()),
      /no token balance value/
    );
  it("returns a fee estimate for a deposit without signing or submitting", async () => {
    const server = createMockServer([successSimulation()]);
    const result = await createClient(server).simulateDepositTransaction(
      admin.publicKey(),
      "00000000-0000-0000-0000-000000000007"
    );

    assert.deepEqual(result, {
      success: true,
      minResourceFee: "100",
      needsRestoration: false,
      estimatedFeeXlm: "0.00002",
    });
    assert.deepEqual(server.calls.send, []);
  });

  it("includes state restoration fees when simulation returns a restore preamble", async () => {
    const restoreSimulation = {
      ...successSimulation(),
      restorePreamble: {
        minResourceFee: "500",
        transactionData: new SorobanDataBuilder(),
      },
    };
    const server = createMockServer([restoreSimulation]);
    const result = await createClient(server).simulateDepositTransaction(
      admin.publicKey(),
      "00000000-0000-0000-0000-000000000007"
    );

    assert.deepEqual(result, {
      success: true,
      minResourceFee: "100",
      needsRestoration: true,
      estimatedFeeXlm: "0.00008",
    });
    assert.deepEqual(server.calls.send, []);
  });

  it("returns a specific simulation error instead of submitting", async () => {
    const server = createMockServer([
      { id: "1", latestLedger: 100, events: [], _parsed: true, error: "HostError: insufficient balance" },
    ]);
    const result = await createClient(server).simulateDepositTransaction(
      admin.publicKey(),
      "00000000-0000-0000-0000-000000000007"
    );

    assert.deepEqual(result, {
      success: false,
      error: "Simulation failed: HostError: insufficient balance",
    });
    assert.deepEqual(server.calls.send, []);
  });
});


describe("Soroban transport chaos", () => {
  it("retains the signed deposit hash on 100% submission response drops and never rebuilds it", async () => {
    const server = createMockServer([successSimulation()]);
    let sends = 0;
    server.sendTransaction = async () => { sends++; throw new Error("ETIMEDOUT injected 100% drop"); };
    const result = await createClient(server).deposit(admin.secret(), admin.publicKey(), 7);
    assert.equal(result.success, false);
    assert.equal(result.uncertain, true);
    assert.match(result.txHash!, /^[a-f0-9]{64}$/);
    assert.equal(sends, 1); assert.equal(server.calls.simulate, 1);
  });
  it("journals settlement before submission and replays only its exact signed envelope", async () => {
    const server = createMockServer([successSimulation()]);
    let envelope = "", hash = "", sends = 0;
    server.sendTransaction = async (tx: any) => {
      sends++;
      assert.equal(Buffer.from(tx.hash()).toString("hex"), hash);
      assert.equal(tx.toXDR(), envelope);
      if (sends === 1) throw new Error("ECONNRESET response lost");
      return { status: "DUPLICATE", hash };
    };
    const client = createClient(server);
    const result = await client.settle(admin.secret(), admin.publicKey(), 7, [], admin.publicKey(), 0n,
      async (signedHash, signedEnvelope) => { hash = signedHash; envelope = signedEnvelope; });
    assert.equal(result.uncertain, true);
    const recovered = await client.resumeEnvelope(envelope);
    assert.equal(recovered.success, true); assert.equal(recovered.txHash, hash);
    assert.equal(server.calls.simulate, 1); assert.equal(sends, 2);
  });
  it("does not submit a settlement when its durable journal is unavailable", async () => {
    const server = createMockServer([successSimulation()]);
    const result = await createClient(server).settle(admin.secret(), admin.publicKey(), 7, [], admin.publicKey(), 0n,
      async () => { throw new Error("database disconnected before journal"); });
    assert.equal(result.success, false); assert.equal(server.calls.send.length, 0);
  });
});
