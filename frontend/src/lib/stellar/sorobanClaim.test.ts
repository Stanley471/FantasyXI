import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, Networks, Operation } from "@stellar/stellar-sdk";
import {
  buildClaimPrizeTx,
  claimEscrowPrize,
  mapClaimErrorToMessage,
  SorobanClaimError,
} from "./sorobanClaim.js";

test("Soroban Escrow Prize Claim Architecture (Issue #546)", async (t) => {
  const winner = Keypair.random();
  const testContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const leagueId = 42;

  await t.test("buildClaimPrizeTx creates a valid transaction invoking claim_prize", () => {
    const mockAccount = {
      accountId: () => winner.publicKey(),
      sequenceNumber: () => "500",
      incrementSequenceNumber: () => {},
    };

    const tx = buildClaimPrizeTx(mockAccount, testContractId, leagueId, winner.publicKey(), Networks.TESTNET);

    assert.ok(tx);
    assert.equal(tx.operations.length, 1);
    const op: any = tx.operations[0];
    assert.equal(op.type, "invokeHostFunction");
  });

  await t.test("mapClaimErrorToMessage maps contract and wallet errors cleanly", () => {
    assert.equal(
      mapClaimErrorToMessage(new Error("User declined access")),
      "Signature request was rejected in your wallet."
    );
    assert.equal(
      mapClaimErrorToMessage(new Error("HostError: NoClaimablePrize")),
      "No claimable prize found. You may not be an authorized winner or the prize has already been claimed."
    );
    assert.equal(
      mapClaimErrorToMessage(new Error("HostError: ContractPaused")),
      "The escrow contract is currently paused. Please try again later."
    );
    assert.equal(
      mapClaimErrorToMessage(new Error("HostError: LeagueNotFound")),
      "League escrow not found on-chain."
    );
    assert.equal(
      mapClaimErrorToMessage(new Error("NetworkError: failed to fetch")),
      "Could not reach the Stellar network. Check your connection and retry."
    );
  });

  await t.test("claimEscrowPrize executes end-to-end claim simulation, signature, and confirmation", async () => {
    let progressUpdates: string[] = [];
    const mockServer = {
      getAccount: async () => ({
        accountId: () => winner.publicKey(),
        sequenceNumber: () => "500",
        incrementSequenceNumber: () => {},
      }),
      simulateTransaction: async () => ({
        results: [{ auth: [], xdr: "AAAA" }],
        minResourceFee: "100",
      }),
      assembleTransaction: (tx: any) => tx,
      sendTransaction: async () => ({
        status: "PENDING",
        hash: "claim1234567890abcdefclaim1234567890abcdefclaim1234567890abcdef",
      }),
      getTransaction: async () => ({
        status: "SUCCESS",
        latestLedger: 999888,
      }),
    };

    const mockSigner = async (xdr: string) => {
      // Simulates Freighter signing
      return xdr;
    };

    const result = await claimEscrowPrize({
      escrowContractId: testContractId,
      leagueId,
      winnerPublicKey: winner.publicKey(),
      signTransaction: mockSigner,
      server: mockServer,
      onProgress: (msg) => progressUpdates.push(msg),
    });

    assert.equal(result.success, true);
    assert.equal(result.txHash, "claim1234567890abcdefclaim1234567890abcdefclaim1234567890abcdef");
    assert.equal(result.leagueId, "42");
    assert.equal(result.winnerAddress, winner.publicKey());
    assert.equal(result.ledgerSeq, 999888);
    assert.ok(progressUpdates.length > 0);
  });

  await t.test("claimEscrowPrize rejects when wallet signature fails or is rejected", async () => {
    const mockServer = {
      getAccount: async () => ({
        accountId: () => winner.publicKey(),
        sequenceNumber: () => "500",
        incrementSequenceNumber: () => {},
      }),
      simulateTransaction: async () => ({
        results: [{ auth: [], xdr: "AAAA" }],
        minResourceFee: "100",
      }),
      assembleTransaction: (tx: any) => tx,
    };

    const rejectingSigner = async () => {
      throw new Error("User declined access");
    };

    await assert.rejects(
      async () => {
        await claimEscrowPrize({
          escrowContractId: testContractId,
          leagueId,
          winnerPublicKey: winner.publicKey(),
          signTransaction: rejectingSigner,
          server: mockServer,
        });
      },
      (err: any) => {
        assert.ok(err instanceof SorobanClaimError);
        assert.equal(err.code, "SIGNATURE_REJECTED");
        assert.ok(err.message.includes("Signature request was rejected"));
        return true;
      }
    );
  });
});
