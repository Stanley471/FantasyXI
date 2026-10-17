import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Address, Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";
import { createLeague, isAllowedTokenAsset } from "../controllers/league.controller.js";

function randomContractStrkey(): string {
  return Address.contract(Keypair.random().rawPublicKey()).toString();
}

describe("Multi-Token Entry Fee Escrow Support (#257)", () => {
  it("encodes dynamic SAC token contract addresses in SorobanContractClient.createLeague and whitelistAsset", async () => {
    const escrowId = randomContractStrkey();
    const defaultUsdcId = randomContractStrkey();
    const customEurcId = randomContractStrkey();
    const creatorKp = Keypair.random();

    const capturedCalls: Array<{ contractId: string; method: string; args: xdr.ScVal[] }> = [];

    const client = new SorobanContractClient({
      escrowContractId: escrowId,
      usdcContractId: defaultUsdcId,
    });

    // Stub invoke to inspect encoded ScVal parameters
    client.invoke = async (_secret, contractId, method, args) => {
      capturedCalls.push({ contractId, method, args });
      return { success: true, txHash: "mock-tx-hash" };
    };

    await client.createLeague(
      creatorKp.secret(),
      creatorKp.publicKey(),
      42,
      250_000_000n,
      customEurcId
    );

    assert.equal(capturedCalls.length, 1);
    assert.equal(capturedCalls[0].method, "create_league");
    assert.equal(capturedCalls[0].args.length, 4);
    assert.equal(scValToNative(capturedCalls[0].args[1]), 42n);
    assert.equal(scValToNative(capturedCalls[0].args[2]), 250_000_000n);
    assert.equal(scValToNative(capturedCalls[0].args[3]), customEurcId);

    // Whitelist asset encoding check
    await client.whitelistAsset(creatorKp.secret(), creatorKp.publicKey(), customEurcId);
    assert.equal(capturedCalls[1].method, "whitelist_asset");
    assert.equal(scValToNative(capturedCalls[1].args[1]), customEurcId);
  });

  it("validates whitelisted Soroban SAC token addresses in league.controller.ts", async () => {
    const allowedUsdc = randomContractStrkey();
    const unwhitelistedToken = randomContractStrkey();
    process.env.STELLAR_ALLOWED_TOKEN_CONTRACTS = allowedUsdc;

    assert.equal(isAllowedTokenAsset(allowedUsdc), true);
    assert.equal(isAllowedTokenAsset(unwhitelistedToken), false);
    assert.equal(isAllowedTokenAsset("not-a-contract-id"), false);

    let statusCode = 200;
    let payload: any = null;
    const req: any = {
      user: { id: "creator-1" },
      body: {
        name: "Invalid Token League",
        tokenAddress: unwhitelistedToken,
      },
    };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: unknown) {
        payload = data;
        return this;
      },
    };

    await createLeague(req, res, (err) => {
      if (err) throw err;
    });

    assert.equal(statusCode, 400);
    assert.equal(payload.success, false);
    assert.match(payload.message, /not a valid whitelisted Soroban SAC address/);

    delete process.env.STELLAR_ALLOWED_TOKEN_CONTRACTS;
  });
});
