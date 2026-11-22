import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, xdr, rpc, SorobanDataBuilder } from "@stellar/stellar-sdk";
import {
  DepositCancelledError,
  depositToSorobanEscrow,
  mapSimulationError,
  stroopsToXlm,
  type SimulationServer,
} from "../lib/stellar/sorobanDeposit";

const ESCROW = "CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA";
const USER = Keypair.random().publicKey();

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

function mockServer(simulate: () => Promise<unknown>): SimulationServer {
  return {
    getAccount: async () => new Account(USER, "1"),
    simulateTransaction: simulate as SimulationServer["simulateTransaction"],
    sendTransaction: async () => {
      throw new Error("sendTransaction must not be called");
    },
    getTransaction: async () => {
      throw new Error("getTransaction must not be called");
    },
  };
}

function params(server: SimulationServer, extra: Partial<Parameters<typeof depositToSorobanEscrow>[0]> = {}) {
  const state = { signCalls: 0 };
  return {
    state,
    args: {
      escrowContractId: ESCROW,
      leagueId: 7,
      userPublicKey: USER,
      server,
      signTransaction: async (x: string) => {
        state.signCalls++;
        return { signedTxXdr: x };
      },
      ...extra,
    },
  };
}

describe("stroopsToXlm", () => {
  it("formats stroops as XLM", () => {
    assert.equal(stroopsToXlm("100"), "0.00001");
    assert.equal(stroopsToXlm("10000000"), "1");
    assert.equal(stroopsToXlm(BigInt(250100)), "0.02501");
  });
});

describe("mapSimulationError", () => {
  it("maps known contract error codes", () => {
    assert.match(mapSimulationError("HostError: Error(Contract, #6)"), /already deposited/);
    assert.match(mapSimulationError("Error(Contract, #5)"), /no longer accepting/);
  });

  it("maps LeagueFull and InsufficientBalance messages", () => {
    assert.match(mapSimulationError("LeagueFull"), /league is full/i);
    assert.match(mapSimulationError("InsufficientBalance"), /Insufficient USDC/);
  });

  it("falls back to the raw message", () => {
    assert.match(mapSimulationError("weird"), /simulation failed: weird/);
  });
});

describe("depositToSorobanEscrow pre-simulation", () => {
  it("shows the fee breakdown and cancels before the wallet when the user declines", async () => {
    const server = mockServer(async () => successSim("250000"));
    let seen: Parameters<NonNullable<Parameters<typeof depositToSorobanEscrow>[0]["onFeeEstimate"]>>[0] | undefined;
    const { args, state } = params(server, {
      onFeeEstimate: async (estimate) => {
        seen = estimate;
        return false;
      },
    });
    await assert.rejects(depositToSorobanEscrow(args), DepositCancelledError);
    assert.equal(state.signCalls, 0);
    assert.equal(seen?.resourceFeeStroops, "250000");
    assert.equal(seen?.inclusionFeeStroops, "100");
    assert.equal(seen?.totalFeeStroops, "250100");
    assert.equal(seen?.totalFeeXlm, "0.02501");
  });

  it("does not open the wallet when simulation returns a contract error", async () => {
    const server = mockServer(async () => ({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      error: "HostError: Error(Contract, #5)",
    }));
    const { args, state } = params(server, {
      onFeeEstimate: async () => {
        throw new Error("fee review must not be reached");
      },
    });
    await assert.rejects(depositToSorobanEscrow(args), /no longer accepting deposits/);
    assert.equal(state.signCalls, 0);
  });

  it("does not open the wallet when the RPC call itself reverts with a readable error", async () => {
    const server = mockServer(async () => {
      throw new Error("InsufficientBalance");
    });
    const { args, state } = params(server);
    await assert.rejects(depositToSorobanEscrow(args), /Insufficient USDC/);
    assert.equal(state.signCalls, 0);
  });

  it("identifies simulation errors with the SDK type guard", () => {
    assert.equal(rpc.Api.isSimulationError({ error: "x" } as never), true);
  });
});
