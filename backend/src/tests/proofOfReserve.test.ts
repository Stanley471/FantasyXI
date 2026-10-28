import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  buildReserveTree,
  getInclusionProof,
  ProofOfReserveService,
  verifyInclusionProof,
  type ReserveLeaf,
} from "../services/financial/proofOfReserveService.js";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";
import { toContractLeagueId } from "../services/financial/contractLeagueId.js";
import { getProofOfReserve } from "../controllers/financial.controller.js";

function leaves(count: number, amount = 50_000_000n): ReserveLeaf[] {
  return Array.from({ length: count }, (_, i) => ({
    contractLeagueId: String(1_000 + (i % 7)),
    address: `G${i.toString().padStart(55, "A")}`,
    amountStroops: amount,
  }));
}

/** Ledger rows as Prisma would return them for `count` confirmed members. */
function ledgerMembers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    leagueId: `${(i % 9).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    stellarAddress: Keypair.random().publicKey(),
    league: { entryFee: "5.00" },
  }));
}

function createService(options: {
  members: ReturnType<typeof ledgerMembers>;
  onChain?: (contractLeagueId: bigint, address: string) => bigint;
  reserve?: bigint;
  failRead?: boolean;
}) {
  const alerts: Array<{ title: string; severity: string; text: string }> = [];
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const service = new ProofOfReserveService({
    db: { leagueMember: { findMany: async () => options.members } },
    contract: {
      getDepositStrict: async (leagueId, address) => {
        if (options.failRead) throw new Error("get_deposit read failed: RPC timeout");
        return options.onChain ? options.onChain(leagueId, address) : 50_000_000n;
      },
      getEscrowReserveBalance: async () => options.reserve ?? BigInt(options.members.length) * 50_000_000n,
    },
    alerts: {
      notify: async (alert) => {
        alerts.push(alert);
        return { slack: "sent", email: { sent: 1, failed: 0 } };
      },
    },
    audit: { record: (entry) => audits.push(entry as never) },
  });
  return { service, alerts, audits };
}

describe("proof-of-reserve Merkle tree", () => {
  it("is deterministic and independent of input order", () => {
    const input = leaves(25);
    assert.equal(buildReserveTree(input).root, buildReserveTree([...input].reverse()).root);
  });

  it("produces verifiable inclusion proofs for every leaf, including odd levels", () => {
    for (const count of [1, 2, 3, 5, 7, 16, 33]) {
      const tree = buildReserveTree(leaves(count));
      tree.leaves.forEach((leaf, index) => {
        const proof = getInclusionProof(tree, index);
        assert.equal(verifyInclusionProof(leaf, proof, tree.root), true, `${count}/${index}`);
        assert.equal(
          verifyInclusionProof({ ...leaf, amountStroops: leaf.amountStroops - 1n }, proof, tree.root),
          false
        );
      });
    }
  });

  it("changes the root on a 1-stroop change to any leaf", () => {
    const input = leaves(500);
    const root = buildReserveTree(input).root;
    const tampered = input.map((leaf, i) => (i === 321 ? { ...leaf, amountStroops: leaf.amountStroops + 1n } : leaf));
    assert.notEqual(buildReserveTree(tampered).root, root);
  });

  it("does not let a duplicated leaf reproduce the root", () => {
    const input = leaves(3);
    assert.notEqual(buildReserveTree(input).root, buildReserveTree([...input, input[2]]).root);
  });
});

describe("ProofOfReserveService", () => {
  it("verifies a balanced escrow without alerting", async () => {
    const { service, alerts, audits } = createService({ members: ledgerMembers(40) });
    const snapshot = await service.generateSnapshot("manual");

    assert.equal(snapshot.status, "VERIFIED");
    assert.equal(snapshot.ledgerRoot, snapshot.onChainRoot);
    assert.equal(snapshot.depositCount, 40);
    assert.equal(snapshot.liabilitiesStroops, "2000000000");
    assert.equal(alerts.length, 0);
    assert.equal(audits[0].action, "RECONCILIATION_BALANCED");
    assert.equal(audits[0].metadata?.source, "proof-of-reserve");
  });

  it("detects a 1-stroop on-chain divergence and dispatches a critical alert", async () => {
    const members = ledgerMembers(30);
    const victim = members[17];
    const { service, alerts, audits } = createService({
      members,
      onChain: (leagueId, address) =>
        leagueId === toContractLeagueId(victim.leagueId) && address === victim.stellarAddress
          ? 49_999_999n
          : 50_000_000n,
    });
    const snapshot = await service.generateSnapshot();

    assert.equal(snapshot.status, "DISCREPANCY");
    assert.notEqual(snapshot.ledgerRoot, snapshot.onChainRoot);
    assert.deepEqual(snapshot.discrepancies, [
      {
        type: "DEPOSIT_MISMATCH",
        contractLeagueId: toContractLeagueId(victim.leagueId).toString(),
        address: victim.stellarAddress,
        expectedStroops: "50000000",
        onChainStroops: "49999999",
      },
    ]);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "critical");
    assert.match(alerts[0].text, new RegExp(victim.stellarAddress));
    assert.equal(audits[0].action, "RECONCILIATION_DISCREPANCY");
  });

  it("detects a reserve shortfall of a single stroop", async () => {
    const { service, alerts } = createService({ members: ledgerMembers(10), reserve: 499_999_999n });
    const snapshot = await service.generateSnapshot();

    assert.equal(snapshot.status, "DISCREPANCY");
    assert.equal(snapshot.ledgerRoot, snapshot.onChainRoot);
    assert.deepEqual(snapshot.discrepancies, [
      { type: "RESERVE_SHORTFALL", liabilitiesStroops: "500000000", reserveStroops: "499999999" },
    ]);
    assert.equal(alerts.length, 1);
  });

  it("generates a proof for 5,000 deposits in under one second", async () => {
    const { service } = createService({ members: ledgerMembers(5_000) });
    const started = performance.now();
    const snapshot = await service.generateSnapshot();
    const elapsed = performance.now() - started;

    assert.equal(snapshot.depositCount, 5_000);
    assert.equal(snapshot.status, "VERIFIED");
    assert.ok(elapsed < 1_000, `took ${elapsed.toFixed(0)}ms`);
  });

  it("does not publish a snapshot when an on-chain read fails", async () => {
    const { service, alerts } = createService({ members: ledgerMembers(5), failRead: true });
    await assert.rejects(service.generateSnapshot(), /RPC timeout/);
    assert.equal(service.getLatestSnapshot(), null);
    assert.equal(alerts.length, 0);
  });

  it("exposes only roots and totals publicly", async () => {
    const members = ledgerMembers(3);
    const { service } = createService({ members, onChain: () => 1n });
    await service.generateSnapshot();
    const publicView = service.getPublicSnapshot()!;

    assert.equal(publicView.discrepancyCount, 3);
    assert.equal("discrepancies" in publicView, false);
    for (const member of members) {
      assert.doesNotMatch(JSON.stringify(publicView), new RegExp(member.stellarAddress));
    }
  });
});

describe("proof-of-reserve contract reads", () => {
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 4));
  const failing: any = {
    simulateTransaction: async () => ({ id: "1", latestLedger: 1, events: [], _parsed: true, error: "RPC timeout" }),
  };

  it("throws instead of reading zero when the RPC call fails", async () => {
    const client = new SorobanContractClient({ server: failing, escrowContractId: contractId, usdcContractId: contractId });
    await assert.rejects(client.getDepositStrict(1n, Keypair.random().publicKey()), /get_deposit read failed/);
    await assert.rejects(client.getEscrowReserveBalance(), /balance read failed/);
  });
});

describe("GET /proof-of-reserve", () => {
  it("returns 503 until a snapshot has been generated", async () => {
    let status = 0;
    const res: any = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    };
    await getProofOfReserve({} as never, res);
    assert.equal(status, 503);
  });
});
