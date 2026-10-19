import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 5));
const WASM_HASH = "ab".repeat(32);
const signers = [Keypair.random(), Keypair.random(), Keypair.random()];

function decodeCall(call: any) {
  return {
    method: Buffer.from(call.functionName.bytes).toString(),
    args: call.args.map((arg: xdr.ScVal) => scValToNative(arg)),
  };
}

function mockServer() {
  const invoked: any[] = [];
  const server: any = {
    invoked,
    getFeeStats: async () => {
      throw new Error("fee stats unavailable");
    },
    getAccount: async (pub: string) => new Account(pub, "1"),
    getLatestLedger: async () => ({ sequence: 100 }),
    simulateTransaction: async (tx: any) => {
      invoked.push(tx.operations[0].func.invokeContract);
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
    sendTransaction: async () => ({ status: "PENDING", hash: "c".repeat(64) }),
    getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
  };
  return server;
}

function createClient(server: any) {
  return new SorobanContractClient({ server, escrowContractId: CONTRACT_ID, pollIntervalMs: 1 });
}

describe("SorobanContractClient multi-sig contract upgrade", () => {
  it("proposes an upgrade with the proposer address and WASM hash", async () => {
    const server = mockServer();
    const res = await createClient(server).proposeUpgrade(signers[0].secret(), WASM_HASH);

    assert.equal(res.success, true);
    const call = decodeCall(server.invoked[0]);
    assert.equal(call.method, "propose_upgrade");
    assert.equal(call.args[0], signers[0].publicKey());
    assert.equal(Buffer.from(call.args[1]).toString("hex"), WASM_HASH);
  });

  it("submits the upgrade with every approver in the approvals vector", async () => {
    const server = mockServer();
    const secrets = signers.slice(0, 2).map((kp) => kp.secret());
    const res = await createClient(server).upgradeWithMultisig(secrets, WASM_HASH, 2);

    assert.equal(res.success, true);
    const call = decodeCall(server.invoked.at(-1));
    assert.equal(call.method, "upgrade");
    assert.deepEqual(call.args[0], [signers[0].publicKey(), signers[1].publicKey()]);
    assert.equal(Buffer.from(call.args[1]).toString("hex"), WASM_HASH);
  });

  it("rejects insufficient or duplicated signers before reaching the network", async () => {
    const server = mockServer();
    const client = createClient(server);

    const single = await client.upgradeWithMultisig([signers[0].secret()], WASM_HASH, 2);
    assert.equal(single.success, false);
    assert.match(single.error!, /Insufficient signatures/);

    const duplicated = await client.upgradeWithMultisig(
      [signers[0].secret(), signers[0].secret()],
      WASM_HASH,
      2
    );
    assert.equal(duplicated.success, false);
    assert.match(duplicated.error!, /Insufficient signatures/);

    const badHash = await client.upgradeWithMultisig(
      signers.map((kp) => kp.secret()),
      "not-a-hash",
      2
    );
    assert.equal(badHash.success, false);
    assert.equal(server.invoked.length, 0);
  });
});
