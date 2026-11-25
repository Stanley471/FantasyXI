import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Keypair } from "@stellar/stellar-sdk";
import {
  MicropaymentChannelService,
  MicropaymentChannelError,
  MICROPAYMENT_FEE_SCHEDULE_STROOPS,
  buildMicropaymentStateMessage,
  hashActionPayload,
  signStellarEd25519Message,
  type ChannelSettlementCommitRecord,
} from "../services/financial/micropaymentChannelService.js";

describe("Instant Micropayment Channel for Gameweek Live Substitution Fees (Issue #427)", () => {
  it("completes off-chain sub-cent micropayment state updates in under 50ms without waiting for block confirmation", () => {
    const service = new MicropaymentChannelService();
    const participant = Keypair.random();

    const channel = service.openChannel({
      userId: "user-101",
      squadId: "squad-101",
      gameweekId: 12,
      participantAddress: participant.publicKey(),
      depositTxHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      depositStroops: 1_000_000n, // 0.10 USDC deposit
    });

    const increment = MICROPAYMENT_FEE_SCHEDULE_STROOPS.LIVE_SUBSTITUTION; // 25,000 stroops (0.25 cents)
    const actionPayload = { playerOutId: 10, playerInId: 14, minute: 62 };
    const payloadHash = hashActionPayload(actionPayload);
    const message = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 12,
      sequence: 1,
      cumulativeSpentStroops: increment,
      actionType: "LIVE_SUBSTITUTION",
      payloadHash,
    });
    const signature = signStellarEd25519Message(participant, message);

    const startMs = performance.now();
    const signedState = service.applyStateUpdate({
      channelId: channel.channelId,
      sequence: 1,
      incrementStroops: increment,
      cumulativeSpentStroops: increment,
      actionType: "LIVE_SUBSTITUTION",
      actionPayload,
      signature,
    });
    const elapsedMs = performance.now() - startMs;

    assert.ok(
      elapsedMs < 50,
      `Expected state update to complete in < 50ms, took ${elapsedMs.toFixed(2)}ms`
    );
    assert.equal(signedState.sequence, 1);
    assert.equal(signedState.cumulativeSpentStroops, 25_000n);
    assert.equal(signedState.remainingBalanceStroops, 975_000n);
    assert.ok(signedState.platformCounterSignature.length > 0);
  });

  it("enforces monotonic state sequence incrementing and rejects older or duplicate state replays", () => {
    const service = new MicropaymentChannelService();
    const participant = Keypair.random();

    const channel = service.openChannel({
      userId: "user-202",
      squadId: "squad-202",
      gameweekId: 15,
      participantAddress: participant.publicKey(),
      depositTxHash: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      depositStroops: 500_000n,
    });

    // Apply sequence 1
    const payload1 = { sub: "A->B" };
    const msg1 = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 15,
      sequence: 1,
      cumulativeSpentStroops: 25_000n,
      actionType: "LIVE_SUBSTITUTION",
      payloadHash: hashActionPayload(payload1),
    });
    const sig1 = signStellarEd25519Message(participant, msg1);

    service.applyStateUpdate({
      channelId: channel.channelId,
      sequence: 1,
      incrementStroops: 25_000n,
      cumulativeSpentStroops: 25_000n,
      actionType: "LIVE_SUBSTITUTION",
      actionPayload: payload1,
      signature: sig1,
    });

    // Apply sequence 2 (emergency captain switch)
    const payload2 = { newCaptainId: 9 };
    const msg2 = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 15,
      sequence: 2,
      cumulativeSpentStroops: 75_000n,
      actionType: "EMERGENCY_CAPTAIN_SWITCH",
      payloadHash: hashActionPayload(payload2),
    });
    const sig2 = signStellarEd25519Message(participant, msg2);

    service.applyStateUpdate({
      channelId: channel.channelId,
      sequence: 2,
      incrementStroops: 50_000n,
      cumulativeSpentStroops: 75_000n,
      actionType: "EMERGENCY_CAPTAIN_SWITCH",
      actionPayload: payload2,
      signature: sig2,
    });

    // Replaying sequence 1 must be rejected
    assert.throws(
      () =>
        service.applyStateUpdate({
          channelId: channel.channelId,
          sequence: 1,
          incrementStroops: 25_000n,
          cumulativeSpentStroops: 25_000n,
          actionType: "LIVE_SUBSTITUTION",
          actionPayload: payload1,
          signature: sig1,
        }),
      (err: unknown) =>
        err instanceof MicropaymentChannelError && err.code === "STALE_SEQUENCE_REPLAY"
    );

    // Replaying sequence 2 must be rejected
    assert.throws(
      () =>
        service.applyStateUpdate({
          channelId: channel.channelId,
          sequence: 2,
          incrementStroops: 50_000n,
          cumulativeSpentStroops: 75_000n,
          actionType: "EMERGENCY_CAPTAIN_SWITCH",
          actionPayload: payload2,
          signature: sig2,
        }),
      (err: unknown) =>
        err instanceof MicropaymentChannelError && err.code === "STALE_SEQUENCE_REPLAY"
    );

    // Non-monotonic jump (sequence 4 instead of 3) must be rejected
    const payload4 = { sub: "C->D" };
    const msg4 = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 15,
      sequence: 4,
      cumulativeSpentStroops: 100_000n,
      actionType: "LIVE_SUBSTITUTION",
      payloadHash: hashActionPayload(payload4),
    });
    const sig4 = signStellarEd25519Message(participant, msg4);

    assert.throws(
      () =>
        service.applyStateUpdate({
          channelId: channel.channelId,
          sequence: 4,
          incrementStroops: 25_000n,
          cumulativeSpentStroops: 100_000n,
          actionType: "LIVE_SUBSTITUTION",
          actionPayload: payload4,
          signature: sig4,
        }),
      (err: unknown) =>
        err instanceof MicropaymentChannelError && err.code === "NON_MONOTONIC_SEQUENCE"
    );
  });

  it("rejects tampered signatures and overdrafts exceeding the channel deposit", () => {
    const service = new MicropaymentChannelService();
    const participant = Keypair.random();
    const attacker = Keypair.random();

    const channel = service.openChannel({
      userId: "user-303",
      squadId: "squad-303",
      gameweekId: 18,
      participantAddress: participant.publicKey(),
      depositTxHash: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      depositStroops: 40_000n,
    });

    const payload = { sub: "1->2" };
    const msg = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 18,
      sequence: 1,
      cumulativeSpentStroops: 25_000n,
      actionType: "LIVE_SUBSTITUTION",
      payloadHash: hashActionPayload(payload),
    });

    // Signed by wrong keypair
    const wrongSig = signStellarEd25519Message(attacker, msg);
    assert.throws(
      () =>
        service.applyStateUpdate({
          channelId: channel.channelId,
          sequence: 1,
          incrementStroops: 25_000n,
          cumulativeSpentStroops: 25_000n,
          actionType: "LIVE_SUBSTITUTION",
          actionPayload: payload,
          signature: wrongSig,
        }),
      (err: unknown) =>
        err instanceof MicropaymentChannelError && err.code === "INVALID_SIGNATURE"
    );

    // Overdraft attempt (50,000 > 40,000 deposit)
    const overdraftMsg = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 18,
      sequence: 1,
      cumulativeSpentStroops: 50_000n,
      actionType: "EMERGENCY_CAPTAIN_SWITCH",
      payloadHash: hashActionPayload(payload),
    });
    const overdraftSig = signStellarEd25519Message(participant, overdraftMsg);

    assert.throws(
      () =>
        service.applyStateUpdate({
          channelId: channel.channelId,
          sequence: 1,
          incrementStroops: 50_000n,
          cumulativeSpentStroops: 50_000n,
          actionType: "EMERGENCY_CAPTAIN_SWITCH",
          actionPayload: payload,
          signature: overdraftSig,
        }),
      (err: unknown) =>
        err instanceof MicropaymentChannelError && err.code === "INSUFFICIENT_CHANNEL_BALANCE"
    );
  });

  it("resolves disputes using cryptographic state sequence numbers, advancing to valid higher sequences and rejecting stale proofs", () => {
    const platformKp = Keypair.random();
    const service = new MicropaymentChannelService({ platformKeypair: platformKp });
    const participant = Keypair.random();

    const channel = service.openChannel({
      userId: "user-404",
      squadId: "squad-404",
      gameweekId: 20,
      participantAddress: participant.publicKey(),
      depositTxHash: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
      depositStroops: 300_000n,
    });

    // Advance channel normally to sequence 1
    const payload1 = { sub: "1->2" };
    const hash1 = hashActionPayload(payload1);
    const msg1 = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 20,
      sequence: 1,
      cumulativeSpentStroops: 25_000n,
      actionType: "LIVE_SUBSTITUTION",
      payloadHash: hash1,
    });
    const sig1 = signStellarEd25519Message(participant, msg1);
    service.applyStateUpdate({
      channelId: channel.channelId,
      sequence: 1,
      incrementStroops: 25_000n,
      cumulativeSpentStroops: 25_000n,
      actionType: "LIVE_SUBSTITUTION",
      actionPayload: payload1,
      signature: sig1,
    });

    // Submit valid higher-sequence state proof (sequence 3, e.g. signed off-chain with platform counter-sig)
    const hash3 = hashActionPayload({ sub: "3->4" });
    const msg3 = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 20,
      sequence: 3,
      cumulativeSpentStroops: 90_000n,
      actionType: "EMERGENCY_CAPTAIN_SWITCH",
      payloadHash: hash3,
    });
    const participantSig3 = signStellarEd25519Message(participant, msg3);
    const platformSig3 = signStellarEd25519Message(platformKp, msg3);

    const resolution = service.submitStateDispute({
      channelId: channel.channelId,
      challengerAddress: participant.publicKey(),
      sequence: 3,
      cumulativeSpentStroops: 90_000n,
      actionType: "EMERGENCY_CAPTAIN_SWITCH",
      payloadHash: hash3,
      participantSignature: participantSig3,
      platformCounterSignature: platformSig3,
    });

    assert.equal(resolution.accepted, true);
    assert.equal(resolution.previousSequence, 1);
    assert.equal(resolution.submittedSequence, 3);
    assert.equal(resolution.resolvedCumulativeSpentStroops, 90_000n);
    assert.equal(resolution.resolvedRemainingBalanceStroops, 210_000n);

    const updatedChannel = service.getChannel(channel.channelId);
    assert.equal(updatedChannel.sequence, 3);
    assert.equal(updatedChannel.cumulativeSpentStroops, 90_000n);

    // Attempting to dispute with an older sequence (sequence 2) must be rejected
    const hash2 = hashActionPayload({ sub: "2->3" });
    const msg2 = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: 20,
      sequence: 2,
      cumulativeSpentStroops: 50_000n,
      actionType: "LIVE_SUBSTITUTION",
      payloadHash: hash2,
    });
    const participantSig2 = signStellarEd25519Message(participant, msg2);

    assert.throws(
      () =>
        service.submitStateDispute({
          channelId: channel.channelId,
          challengerAddress: participant.publicKey(),
          sequence: 2,
          cumulativeSpentStroops: 50_000n,
          actionType: "LIVE_SUBSTITUTION",
          payloadHash: hash2,
          participantSignature: participantSig2,
        }),
      (err: unknown) =>
        err instanceof MicropaymentChannelError && err.code === "DISPUTE_REJECTED"
    );
  });

  it("reconciles and closes off-chain balances via batch settlement worker at gameweek deadline", async () => {
    const dbRecords: ChannelSettlementCommitRecord[] = [];
    const onChainCalls: Array<{ channelId: string; finalSpentStroops: bigint; refundStroops: bigint }> = [];

    const service = new MicropaymentChannelService({
      settlementGateway: {
        commitChannelSettlementOnChain: async (params) => {
          onChainCalls.push({
            channelId: params.channelId,
            finalSpentStroops: params.finalSpentStroops,
            refundStroops: params.refundStroops,
          });
          return {
            success: true,
            txHash: `soroban_tx_${params.channelId}_${params.finalSequence}`,
          };
        },
      },
      dbPersistence: {
        persistChannelSettlement: async (record) => {
          dbRecords.push(record);
        },
      },
    });

    const userA = Keypair.random();
    const userB = Keypair.random();

    const chA = service.openChannel({
      userId: "user-A",
      squadId: "squad-A",
      gameweekId: 25,
      participantAddress: userA.publicKey(),
      depositTxHash: "1111111111111111111111111111111111111111111111111111111111111111",
      depositStroops: 200_000n,
    });

    const chB = service.openChannel({
      userId: "user-B",
      squadId: "squad-B",
      gameweekId: 25,
      participantAddress: userB.publicKey(),
      depositTxHash: "2222222222222222222222222222222222222222222222222222222222222222",
      depositStroops: 150_000n,
    });

    // User A performs 1 live substitution (25,000 stroops)
    const payloadA = { sub: "A1->A2" };
    const msgA = buildMicropaymentStateMessage({
      channelId: chA.channelId,
      gameweekId: 25,
      sequence: 1,
      cumulativeSpentStroops: 25_000n,
      actionType: "LIVE_SUBSTITUTION",
      payloadHash: hashActionPayload(payloadA),
    });
    service.applyStateUpdate({
      channelId: chA.channelId,
      sequence: 1,
      incrementStroops: 25_000n,
      cumulativeSpentStroops: 25_000n,
      actionType: "LIVE_SUBSTITUTION",
      actionPayload: payloadA,
      signature: signStellarEd25519Message(userA, msgA),
    });

    // User B performs 1 emergency captain switch (50,000 stroops)
    const payloadB = { cap: "B9" };
    const msgB = buildMicropaymentStateMessage({
      channelId: chB.channelId,
      gameweekId: 25,
      sequence: 1,
      cumulativeSpentStroops: 50_000n,
      actionType: "EMERGENCY_CAPTAIN_SWITCH",
      payloadHash: hashActionPayload(payloadB),
    });
    service.applyStateUpdate({
      channelId: chB.channelId,
      sequence: 1,
      incrementStroops: 50_000n,
      cumulativeSpentStroops: 50_000n,
      actionType: "EMERGENCY_CAPTAIN_SWITCH",
      actionPayload: payloadB,
      signature: signStellarEd25519Message(userB, msgB),
    });

    // Run batch settlement worker for gameweek 25
    const batchResult = await service.settleGameweekChannels(25);

    assert.equal(batchResult.settledCount, 2);
    assert.equal(batchResult.failedCount, 0);
    assert.equal(batchResult.totalCollectedFeeStroops, 75_000n);
    assert.equal(batchResult.totalRefundedStroops, 275_000n);
    assert.equal(onChainCalls.length, 2);
    assert.equal(dbRecords.length, 2);

    assert.equal(service.getChannel(chA.channelId).status, "SETTLED");
    assert.equal(service.getChannel(chB.channelId).status, "SETTLED");

    // Subsequent updates on settled channel are rejected
    assert.throws(
      () =>
        service.applyStateUpdate({
          channelId: chA.channelId,
          sequence: 2,
          incrementStroops: 25_000n,
          cumulativeSpentStroops: 50_000n,
          actionType: "LIVE_SUBSTITUTION",
          actionPayload: payloadA,
          signature: signStellarEd25519Message(userA, msgA),
        }),
      (err: unknown) =>
        err instanceof MicropaymentChannelError && err.code === "CHANNEL_NOT_OPEN"
    );
  });
});
