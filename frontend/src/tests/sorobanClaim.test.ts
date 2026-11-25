import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, xdr, SorobanDataBuilder } from "@stellar/stellar-sdk";
import {
  claimPrizeFromSorobanEscrow,
  mapClaimError,
  parseContractLeagueId,
} from "../lib/stellar/sorobanClaim";
import type { SimulationServer } from "../lib/stellar/sorobanDeposit";

const ESCROW = "CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA";
const WINNER = Keypair.random().publicKey();

function successSim(minResourceFee = "250000") {
  return {
    id: "1",
    latestLedger: 1,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee,
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
}

function mockServer(
  simulate: () => Promise<unknown>,
  extra: Partial<SimulationServer> = {}
): SimulationServer {
  return {
    getAccount: async () => new Account(WINNER, "1"),
    simulateTransaction: simulate as SimulationServer["simulateTransaction"],
    sendTransaction: async () => ({ status: "PENDING", hash: "test-claim-tx-hash" }),
    getTransaction: async () => ({ status: "SUCCESS", ledger: 12345 }),
    ...extra,
  };
}

describe("parseContractLeagueId", () => {
  it("parses numeric league IDs", () => {
    assert.equal(parseContractLeagueId(42), 42n);
    assert.equal(parseContractLeagueId("100"), 100n);
  });

  it("parses UUID league IDs", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const parsed = parseContractLeagueId(uuid);
    assert.equal(typeof parsed, "bigint");
    assert.ok(parsed > 0n);
  });
});

describe("mapClaimError", () => {
  it("maps contract error codes correctly", () => {
    assert.equal(
      mapClaimError("HostError: Error(Contract, #13)"),
      "No claimable prize found for this address in this competition."
    );
    assert.equal(
      mapClaimError("HostError: Error(Contract, #24)"),
      "Prize has already been claimed for this address."
    );
    assert.equal(
      mapClaimError("HostError: Error(Contract, #14)"),
      "Claim operations are temporarily halted while the escrow contract is paused."
    );
  });
});

describe("claimPrizeFromSorobanEscrow", () => {
  it("executes claim successfully when authorized", async () => {
    let signCalls = 0;
    const server = mockServer(async () => successSim());

    const result = await claimPrizeFromSorobanEscrow({
      escrowContractId: ESCROW,
      leagueId: 99,
      winnerPublicKey: WINNER,
      server,
      signTransaction: async (xdrString) => {
        signCalls++;
        return { signedTxXdr: xdrString };
      },
    });

    assert.equal(result.txHash, "test-claim-tx-hash");
    assert.equal(result.ledger, 12345);
    assert.equal(signCalls, 1);
  });

  it("rejects when simulation errors with NoClaimablePrize", async () => {
    const server = mockServer(async () => ({
      error: "HostError: Error(Contract, #13)",
    }));

    await assert.rejects(
      async () => {
        await claimPrizeFromSorobanEscrow({
          escrowContractId: ESCROW,
          leagueId: 99,
          winnerPublicKey: WINNER,
          server,
          signTransaction: async (xdrString) => ({ signedTxXdr: xdrString }),
        });
      },
      {
        message: "No claimable prize found for this address in this competition.",
      }
    );
  });
});
