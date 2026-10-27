import test from "node:test";
import assert from "node:assert/strict";
import {
  DisputeService,
  DisputeStatus,
} from "../services/financial/disputeService.js";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";

test("DisputeService files dispute and triggers automated escrow freeze", async () => {
  const frozenCalls: { leagueId: bigint; reasonHash: string }[] = [];
  const mockClient = {
    freezeLeague: async (secret: string, adminPub: string, leagueId: bigint, reasonHash: string) => {
      frozenCalls.push({ leagueId, reasonHash });
      return { success: true, txHash: "freeze-tx-001" };
    },
  } as unknown as SorobanContractClient;

  const service = new DisputeService({
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
    adminPublic: "GA00000000000000000000000000000000000000000000000000000000",
  });

  const leagueId = "abcdef01-2345-6789-abcd-ef0123456789";
  const claimant = "GBCLAIMANT1111111111111111111111111111111111111111111111111";

  const dispute = await service.fileDispute({
    leagueId,
    claimantAddress: claimant,
    reason: "Incorrect gameweek 12 bonus points distribution",
    evidenceUrl: "https://proofs.fantasyxi.app/gw12-dispute.json",
  });

  assert.equal(dispute.status, DisputeStatus.UNDER_REVIEW);
  assert.equal(dispute.freezeTxHash, "freeze-tx-001");
  assert.equal(dispute.reasonHash.length, 64);
  assert.equal(dispute.evidence.length, 1);
  assert.equal(frozenCalls.length, 1);
  assert.equal(frozenCalls[0].reasonHash, dispute.reasonHash);
});

test("DisputeService evidence addition and audit tracking", async () => {
  const service = new DisputeService({
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
    adminPublic: "GA00000000000000000000000000000000000000000000000000000000",
    contractClient: {
      freezeLeague: async () => ({ success: true, txHash: "mock-tx" }),
    } as unknown as SorobanContractClient,
  });

  const dispute = await service.fileDispute({
    leagueId: "12345678-1234-1234-1234-1234567890ab",
    claimantAddress: "GUSER1",
    reason: "Stat adjustment mismatch",
  });

  await service.addEvidence(dispute.id, {
    submittedBy: "GUSER1",
    description: "Official FPL API snapshot confirms 3 bonus points were awarded to Haaland",
    evidenceUrl: "https://fpl.api/bootstrap-static/gw2",
  });

  const updated = await service.getDispute(dispute.id);
  assert.equal(updated?.evidence.length, 2);
  assert.match(updated!.evidence[1].description, /Haaland/);
});

test("DisputeService resolveWithPayout successfully executes payouts and updates status", async () => {
  let payoutExecuted = false;
  const mockClient = {
    freezeLeague: async () => ({ success: true, txHash: "freeze-tx" }),
    resolveDisputePayout: async () => {
      payoutExecuted = true;
      return { success: true, txHash: "payout-tx-888" };
    },
  } as unknown as SorobanContractClient;

  const service = new DisputeService({
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
    adminPublic: "GA00000000000000000000000000000000000000000000000000000000",
  });

  const dispute = await service.fileDispute({
    leagueId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    claimantAddress: "GCLAIMANT",
    reason: "Score recalculation required",
  });

  const resolved = await service.resolveWithPayout(dispute.id, {
    winners: [
      { winner: "GWINNER1", amount: "50000000" },
      { winner: "GWINNER2", amount: "30000000" },
    ],
    platformTreasury: "GTREASURY",
    platformFeeStroops: 20000000n,
    notes: "Adjusted points based on Opta official stat corrections",
  });

  assert.equal(payoutExecuted, true);
  assert.equal(resolved.status, DisputeStatus.RESOLVED_PAYOUT);
  assert.equal(resolved.resolutionTxHash, "payout-tx-888");
  assert.equal(resolved.resolutionNotes, "Adjusted points based on Opta official stat corrections");

  // Invariant: cannot re-resolve
  await assert.rejects(
    async () => {
      await service.resolveWithPayout(dispute.id, {
        winners: [],
        platformTreasury: "GTREASURY",
        platformFeeStroops: 0n,
      });
    },
    /Cannot resolve dispute in status RESOLVED_PAYOUT/
  );
});

test("DisputeService resolveWithRefund executes refunds and updates status", async () => {
  let refundExecuted = false;
  const mockClient = {
    freezeLeague: async () => ({ success: true, txHash: "freeze-tx" }),
    resolveDisputeRefund: async () => {
      refundExecuted = true;
      return { success: true, txHash: "refund-tx-999" };
    },
  } as unknown as SorobanContractClient;

  const service = new DisputeService({
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
    adminPublic: "GA00000000000000000000000000000000000000000000000000000000",
  });

  const dispute = await service.fileDispute({
    leagueId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    claimantAddress: "GCLAIMANT",
    reason: "Game abandoned due to force majeure",
  });

  const resolved = await service.resolveWithRefund(dispute.id, {
    participants: ["GPARTICIPANT1", "GPARTICIPANT2"],
    notes: "Full refund issued to all participating managers",
  });

  assert.equal(refundExecuted, true);
  assert.equal(resolved.status, DisputeStatus.RESOLVED_REFUND);
  assert.equal(resolved.resolutionTxHash, "refund-tx-999");
});

test("DisputeService rejectDispute lifts on-chain freeze and marks as REJECTED", async () => {
  let unfreezeCalled = false;
  const mockClient = {
    freezeLeague: async () => ({ success: true, txHash: "freeze-tx-123" }),
    unfreezeLeague: async () => {
      unfreezeCalled = true;
      return { success: true, txHash: "unfreeze-tx-456" };
    },
  } as unknown as SorobanContractClient;

  const service = new DisputeService({
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
    adminPublic: "GA00000000000000000000000000000000000000000000000000000000",
  });

  const dispute = await service.fileDispute({
    leagueId: "cccccccc-dddd-eeee-ffff-000000000000",
    claimantAddress: "GCLAIMANT",
    reason: "False claim without evidence",
  });

  const rejected = await service.rejectDispute(
    dispute.id,
    "Dispute dismissed: official scores verified correct by referee audit"
  );

  assert.equal(unfreezeCalled, true);
  assert.equal(rejected.status, DisputeStatus.REJECTED);
  assert.match(rejected.resolutionNotes!, /official scores verified/);
});

test("DisputeService queries disputes by league ID", async () => {
  const service = new DisputeService({
    contractClient: {
      freezeLeague: async () => ({ success: true, txHash: "tx" }),
    } as unknown as SorobanContractClient,
  });

  const targetLeague = "dddddddd-eeee-ffff-0000-111111111111";
  const otherLeague = "eeeeeeee-ffff-0000-1111-222222222222";

  await service.fileDispute({
    leagueId: targetLeague,
    claimantAddress: "GUSER1",
    reason: "Dispute 1",
    autoFreeze: false,
  });
  await service.fileDispute({
    leagueId: targetLeague,
    claimantAddress: "GUSER2",
    reason: "Dispute 2",
    autoFreeze: false,
  });
  await service.fileDispute({
    leagueId: otherLeague,
    claimantAddress: "GUSER3",
    reason: "Dispute 3",
    autoFreeze: false,
  });

  const targetDisputes = await service.getDisputesForLeague(targetLeague);
  assert.equal(targetDisputes.length, 2);

  const otherDisputes = await service.getDisputesForLeague(otherLeague);
  assert.equal(otherDisputes.length, 1);
});
