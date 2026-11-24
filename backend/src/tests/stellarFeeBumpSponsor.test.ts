import test from "node:test";
import assert from "node:assert/strict";
import {
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  DEFAULT_DAILY_SPONSORSHIP_QUOTA,
  DEFAULT_MAX_SPONSOR_FEE_STROOPS,
  StellarFeeBumpSponsorService,
} from "../services/financial/stellarFeeBumpSponsorService.js";
import { sponsorStellarFeeHandler } from "../controllers/stellarFeeBump.controller.js";

test("Stellar Fee-Bump Sponsor Service (Issue #549)", async (t) => {
  const user = Keypair.random();
  const sponsor = Keypair.random();
  const networkPassphrase = Networks.TESTNET;

  function createValidDepositTx(fee = BASE_FEE): string {
    const userAccount = {
      accountId: () => user.publicKey(),
      sequenceNumber: () => "100",
      incrementSequenceNumber: () => {},
    };

    const tx = new TransactionBuilder(userAccount as any, {
      fee,
      networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "5",
        })
      )
      .setTimeout(300)
      .build();

    tx.sign(user);
    return tx.toXDR();
  }

  function createDisallowedClaimTx(): string {
    const userAccount = {
      accountId: () => user.publicKey(),
      sequenceNumber: () => "101",
      incrementSequenceNumber: () => {},
    };

    const tx = new TransactionBuilder(userAccount as any, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId: "00000000c582f38e2a60179fb11612e1614b29400b530f50ee9315bc810801060904ee24",
        })
      )
      .setTimeout(300)
      .build();

    tx.sign(user);
    return tx.toXDR();
  }

  await t.test("wraps user-signed deposit transaction in FeeBumpTransaction sponsored by platform", async () => {
    const service = new StellarFeeBumpSponsorService({
      sponsorKeypair: sponsor,
      networkPassphrase,
      horizonServer: {
        submitTransaction: async () => ({ ledger: 12345 }),
      },
    });

    const innerXdr = createValidDepositTx();
    const result = await service.sponsorAndBroadcast(innerXdr, "user-123", true);

    assert.equal(result.success, true);
    assert.ok(result.innerTxHash, "Must record inner transaction hash");
    assert.ok(result.feeBumpTxHash, "Must record fee bump transaction hash");
    assert.equal(result.submittedToNetwork, true);
    assert.equal(result.ledgerSeq, 12345);
    assert.ok(result.sponsoredFeeStroops >= parseInt(BASE_FEE, 10) * 2);

    // Verify parsed transaction is indeed a FeeBumpTransaction
    const parsed = TransactionBuilder.fromXDR(result.signedFeeBumpXdr, networkPassphrase);
    assert.ok(parsed instanceof FeeBumpTransaction);
    assert.equal(parsed.feeSource, sponsor.publicKey());
  });

  await t.test("rejects non-transaction or invalid XDR", async () => {
    const service = new StellarFeeBumpSponsorService({
      sponsorKeypair: sponsor,
      networkPassphrase,
    });

    const result = await service.sponsorAndBroadcast("not-a-valid-base64-xdr", "user-456", false);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("Invalid inner transaction XDR"));
  });

  await t.test("disallows wrapping an already fee-bumped transaction", async () => {
    const service = new StellarFeeBumpSponsorService({
      sponsorKeypair: sponsor,
      networkPassphrase,
    });

    const innerXdr = createValidDepositTx();
    const firstResult = await service.sponsorAndBroadcast(innerXdr, "user-789", false);
    assert.equal(firstResult.success, true);

    // Attempt to fee-bump the fee-bump
    const secondResult = await service.sponsorAndBroadcast(firstResult.signedFeeBumpXdr, "user-789", false);
    assert.equal(secondResult.success, false);
    assert.ok(secondResult.error?.includes("Cannot wrap an existing FeeBumpTransaction"));
  });

  await t.test("strictly rejects prize claim withdrawals (out of scope)", async () => {
    const service = new StellarFeeBumpSponsorService({
      sponsorKeypair: sponsor,
      networkPassphrase,
    });

    const claimXdr = createDisallowedClaimTx();
    const result = await service.sponsorAndBroadcast(claimXdr, "user-claimant", false);

    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes("Sponsoring prize claim withdrawals is not permitted"),
      `Expected error about prize claims, got: ${result.error}`
    );
  });

  await t.test("enforces daily sponsorship quotas per user to prevent abuse", async () => {
    const service = new StellarFeeBumpSponsorService({
      sponsorKeypair: sponsor,
      networkPassphrase,
      dailyQuota: 3, // custom test quota of 3
    });

    const testUser = "quota-test-user";

    // 1st attempt: allowed
    const r1 = await service.sponsorAndBroadcast(createValidDepositTx(), testUser, false);
    assert.equal(r1.success, true);
    assert.equal(r1.remainingDailyQuota, 2);

    // 2nd attempt: allowed
    const r2 = await service.sponsorAndBroadcast(createValidDepositTx(), testUser, false);
    assert.equal(r2.success, true);
    assert.equal(r2.remainingDailyQuota, 1);

    // 3rd attempt: allowed
    const r3 = await service.sponsorAndBroadcast(createValidDepositTx(), testUser, false);
    assert.equal(r3.success, true);
    assert.equal(r3.remainingDailyQuota, 0);

    // 4th attempt: REJECTED (quota exceeded)
    const r4 = await service.sponsorAndBroadcast(createValidDepositTx(), testUser, false);
    assert.equal(r4.success, false);
    assert.ok(r4.error?.includes("Daily sponsorship quota exceeded"));

    // Different user should still be allowed
    const otherUserResult = await service.sponsorAndBroadcast(createValidDepositTx(), "other-user", false);
    assert.equal(otherUserResult.success, true);
  });

  await t.test("sponsorStellarFeeHandler returns 200 on success and 400/429 on errors", async () => {
    // 1. Missing innerTxXdr returns 400
    let statusCode = 0;
    let jsonBody: any = null;

    const mockRes: any = {
      status: (code: number) => {
        statusCode = code;
        return mockRes;
      },
      json: (data: any) => {
        jsonBody = data;
        return mockRes;
      },
    };

    await sponsorStellarFeeHandler({ body: {} } as any, mockRes);
    assert.equal(statusCode, 400);
    assert.equal(jsonBody.success, false);
    assert.ok(jsonBody.error?.includes("Missing required parameter"));

    // 2. Valid transaction returns 200
    const validXdr = createValidDepositTx();
    await sponsorStellarFeeHandler(
      {
        body: { innerTxXdr: validXdr },
        ip: "127.0.0.1",
      } as any,
      mockRes
    );

    assert.equal(statusCode, 200);
    assert.equal(jsonBody.success, true);
    assert.ok(jsonBody.feeBumpTxHash);
    assert.ok(jsonBody.signedFeeBumpXdr);
  });
});
