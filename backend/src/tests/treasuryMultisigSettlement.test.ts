import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Address,
  Contract,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  inspectAuthEntry,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";

/**
 * Tests for the treasury multi-sig withdrawal path (issue #114).
 *
 * The escrow contract already gates `settle_with_multisig` behind an M-of-N
 * `AdminConfig` (see contracts/src/lib.rs `authorize_signers`), requiring a
 * `require_auth()` per approving signer. These tests exercise the backend
 * client responsible for collecting one signed Soroban authorization entry
 * per approver and assembling/submitting the resulting transaction, without
 * requiring a live testnet connection (the RPC server is fully mocked).
 */

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 9));
const signerA = Keypair.random();
const signerB = Keypair.random();
const signerC = Keypair.random();

function successSimulation(authEntries: xdr.SorobanAuthorizationEntry[]) {
  return {
    _parsed: true,
    id: "1",
    latestLedger: 1000,
    events: [],
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder(),
    result: { auth: authEntries, retval: xdr.ScVal.scvVoid() },
  };
}

/** Builds an unsigned address-credentialed auth entry requiring `signer` to approve. */
function unsignedAuthEntry(signerPublicKey: string) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signerPublicKey).toScAddress(),
        nonce: xdr.Int64.fromString("123456"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Contract(CONTRACT_ID).address().toScAddress(),
          functionName: "settle_with_multisig",
          args: [],
        })
      ),
      subInvocations: [],
    }),
  });
}

function createMockServer(simulations: any[]) {
  const calls = { simulate: 0, send: 0, getTransaction: 0 };
  const server: any = {
    calls,
    getAccount: async (pub: string) => new Account(pub, "1"),
    getLatestLedger: async () => ({ id: "x", sequence: 1000 }),
    simulateTransaction: async () => simulations[Math.min(calls.simulate++, simulations.length - 1)],
    sendTransaction: async (_tx: any) => {
      calls.send++;
      return { status: "PENDING", hash: `${calls.send}`.repeat(64) };
    },
    getTransaction: async () =>
      ++calls.getTransaction % 2 === 1
        ? { status: rpc.Api.GetTransactionStatus.NOT_FOUND }
        : { status: rpc.Api.GetTransactionStatus.SUCCESS, returnValue: undefined },
  };
  return server;
}

function createClient(server: any) {
  return new SorobanContractClient({
    server,
    escrowContractId: CONTRACT_ID,
    usdcContractId: CONTRACT_ID,
    pollIntervalMs: 1,
  });
}

const WINNERS = [{ winner: signerA.publicKey(), amount: "1000" }];
const TREASURY = Keypair.random().publicKey();

describe("Treasury multi-sig settlement (#114)", () => {
  it("rejects a withdrawal without enough signatures before touching the network", async () => {
    const server = createMockServer([]);
    const client = createClient(server);

    const result = await client.settleWithMultisig(
      [signerA.secret()],
      7,
      WINNERS,
      TREASURY,
      100n,
      2 // requires 2-of-N, only one secret supplied
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /insufficient signatures/i);
    assert.equal(server.calls.simulate, 0, "should fail fast without simulating or hitting the network");
    assert.equal(server.calls.send, 0);
  });

  it("rejects a non-positive threshold", async () => {
    const server = createMockServer([]);
    const client = createClient(server);

    const result = await client.settleWithMultisig(
      [signerA.secret(), signerB.secret()],
      7,
      WINNERS,
      TREASURY,
      100n,
      0
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /threshold must be at least 1/i);
  });

  it("collects a signed auth entry per approver and submits a 2-of-3 approved settlement", async () => {
    const authEntries = [unsignedAuthEntry(signerA.publicKey()), unsignedAuthEntry(signerB.publicKey())];
    const server = createMockServer([successSimulation(authEntries), successSimulation(authEntries)]);
    const client = createClient(server);

    const result = await client.settleWithMultisig(
      [signerA.secret(), signerB.secret()],
      7,
      WINNERS,
      TREASURY,
      100n,
      2
    );

    assert.equal(result.success, true);
    assert.equal(server.calls.send, 1, "exactly one transaction submitted once fully signed");
  });

  it("fails when a required on-chain signer has no matching approver secret", async () => {
    // Simulation demands authorization from signerC, but only A and B secrets were supplied.
    const authEntries = [unsignedAuthEntry(signerA.publicKey()), unsignedAuthEntry(signerC.publicKey())];
    const server = createMockServer([successSimulation(authEntries)]);
    const client = createClient(server);

    const result = await client.settleWithMultisig(
      [signerA.secret(), signerB.secret()],
      7,
      WINNERS,
      TREASURY,
      100n,
      2
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? "", new RegExp(signerC.publicKey()));
    assert.equal(server.calls.send, 0);
  });

  it("propagates simulation failures (e.g. threshold rejected on-chain) without submitting", async () => {
    const server = createMockServer([
      { id: "1", latestLedger: 100, events: [], _parsed: true, error: "HostError: Error(Contract, #15)" },
    ]);
    const client = createClient(server);

    const result = await client.settleWithMultisig(
      [signerA.secret(), signerB.secret()],
      7,
      WINNERS,
      TREASURY,
      100n,
      2
    );

    assert.equal(result.success, false);
    assert.equal(result.contractErrorCode, 15, "InvalidMultisig contract error code surfaces to caller");
    assert.equal(server.calls.send, 0);
  });

  it("builds auth entries whose inspected address matches the intended approver", () => {
    const entry = unsignedAuthEntry(signerA.publicKey());
    const info = inspectAuthEntry(entry);
    assert.equal(info.address, signerA.publicKey());
    assert.equal(info.signed, false);
  });
});
