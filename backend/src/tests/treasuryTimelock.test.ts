import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { CryptographicAuditLog } from "../services/audit/cryptoAuditLog.js";
import { LocalSecretTransactionSigner } from "../services/financial/transactionSigner.js";
import {
  InMemoryTreasuryProposalStore,
  StellarTreasuryWithdrawalExecutor,
  TREASURY_TIMELOCK_MS,
  TreasuryTimelockError,
  TreasuryTimelockService,
  signWithdrawalAction,
  type TreasuryWithdrawalExecutor,
  type WithdrawalAction,
  type WithdrawalProposal,
} from "../services/financial/treasuryTimelockService.js";

const NETWORK = Networks.TESTNET;
const HOUR = 60 * 60 * 1000;

const adminA = Keypair.random();
const adminB = Keypair.random();
const adminC = Keypair.random();
const outsider = Keypair.random();
const destination = Keypair.random().publicKey();
const usdcIssuer = Keypair.random().publicKey();

class RecordingExecutor implements TreasuryWithdrawalExecutor {
  public calls: WithdrawalProposal[] = [];
  public fail = false;
  async execute(proposal: Readonly<WithdrawalProposal>) {
    if (this.fail) throw new Error("horizon unavailable");
    this.calls.push(structuredClone(proposal) as WithdrawalProposal);
    return { transactionHash: `tx-${this.calls.length}` };
  }
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TreasuryTimelockError, `expected TreasuryTimelockError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

describe("TreasuryTimelockService (issue #262)", () => {
  let clock: Date;
  let executor: RecordingExecutor;
  let auditLog: CryptographicAuditLog;
  let store: InMemoryTreasuryProposalStore;
  let service: TreasuryTimelockService;

  const sign = (p: WithdrawalProposal, action: WithdrawalAction, kp: Keypair, network = NETWORK) =>
    signWithdrawalAction(p, action, kp, network);
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeEach(() => {
    clock = new Date("2026-10-01T00:00:00.000Z");
    executor = new RecordingExecutor();
    auditLog = new CryptographicAuditLog();
    store = new InMemoryTreasuryProposalStore();
    service = new TreasuryTimelockService({
      adminPublicKeys: [adminA.publicKey(), adminB.publicKey(), adminC.publicKey()],
      threshold: 2,
      networkPassphrase: NETWORK,
      executor,
      auditLog,
      store,
      now: () => clock,
    });
  });

  async function proposeUsdc(amount = "1500.5000000") {
    return service.propose(
      { destination, amount, asset: { code: "USDC", issuer: usdcIssuer }, memo: "cold storage" },
      adminA.publicKey()
    );
  }

  async function queuedProposal() {
    const p = await proposeUsdc();
    await service.approve(p.id, adminA.publicKey(), sign(p, "APPROVE", adminA));
    return service.approve(p.id, adminB.publicKey(), sign(p, "APPROVE", adminB));
  }

  describe("configuration", () => {
    const base = {
      adminPublicKeys: [adminA.publicKey(), adminB.publicKey()],
      networkPassphrase: NETWORK,
      executor: new RecordingExecutor(),
    };

    it("rejects a 1-of-N threshold so a single key can never move funds", () => {
      assert.throws(() => new TreasuryTimelockService({ ...base, threshold: 1 }), /threshold/);
    });

    it("rejects a threshold larger than the administrator set", () => {
      assert.throws(() => new TreasuryTimelockService({ ...base, threshold: 3 }), /threshold/);
    });

    it("rejects a timelock shorter than 48 hours", () => {
      assert.throws(
        () => new TreasuryTimelockService({ ...base, threshold: 2, timelockMs: TREASURY_TIMELOCK_MS - 1 }),
        /48 hours/
      );
    });

    it("rejects invalid or duplicate administrator keys", () => {
      assert.throws(
        () => new TreasuryTimelockService({ ...base, adminPublicKeys: ["GNOTAKEY", adminA.publicKey()], threshold: 2 }),
        /Invalid administrator/
      );
      assert.throws(
        () => new TreasuryTimelockService({ ...base, adminPublicKeys: [adminA.publicKey(), adminA.publicKey()], threshold: 2 }),
        /unique/
      );
    });
  });

  describe("proposals", () => {
    it("creates a pending proposal and audits it", async () => {
      const p = await proposeUsdc();
      assert.equal(p.status, "PENDING_APPROVAL");
      assert.equal(p.approvals.length, 0);
      assert.equal(auditLog.getChain()[0].action, "TREASURY_WITHDRAWAL_PROPOSED");
    });

    it("only administrators can propose", async () => {
      await expectCode(
        service.propose({ destination, amount: "1", asset: { code: "XLM" } }, outsider.publicKey()),
        "UNAUTHORIZED_SIGNER"
      );
    });

    it("validates destination, amount, asset and memo", async () => {
      const ok = { destination, amount: "10", asset: { code: "XLM" } };
      const cases = [
        { ...ok, destination: "GBAD" },
        { ...ok, amount: "0" },
        { ...ok, amount: "-5" },
        { ...ok, amount: "1.12345678" },
        { ...ok, asset: { code: "USDC" } },
        { ...ok, memo: "x".repeat(29) },
      ];
      for (const request of cases) {
        await expectCode(service.propose(request, adminA.publicKey()), "INVALID_REQUEST");
      }
    });
  });

  describe("signature threshold", () => {
    it("stays pending below the threshold and queues the 48h timelock at M approvals", async () => {
      const p = await proposeUsdc();
      const afterOne = await service.approve(p.id, adminA.publicKey(), sign(p, "APPROVE", adminA));
      assert.equal(afterOne.status, "PENDING_APPROVAL");
      assert.equal(afterOne.executableAt, undefined);

      advance(HOUR);
      const afterTwo = await service.approve(p.id, adminB.publicKey(), sign(p, "APPROVE", adminB));
      assert.equal(afterTwo.status, "QUEUED");
      assert.equal(new Date(afterTwo.executableAt!).getTime(), clock.getTime() + TREASURY_TIMELOCK_MS);
    });

    it("cannot execute without meeting the threshold, even after 48 hours", async () => {
      const p = await proposeUsdc();
      await service.approve(p.id, adminA.publicKey(), sign(p, "APPROVE", adminA));
      advance(TREASURY_TIMELOCK_MS + HOUR);
      await expectCode(service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA)), "THRESHOLD_NOT_MET");
      assert.equal(executor.calls.length, 0);
    });

    it("rejects duplicate approvals from the same administrator", async () => {
      const p = await proposeUsdc();
      const sig = sign(p, "APPROVE", adminA);
      await service.approve(p.id, adminA.publicKey(), sig);
      await expectCode(service.approve(p.id, adminA.publicKey(), sig), "DUPLICATE_APPROVAL");
    });

    it("rejects approvals from keys outside the administrator set", async () => {
      const p = await proposeUsdc();
      await expectCode(
        service.approve(p.id, outsider.publicKey(), sign(p, "APPROVE", outsider)),
        "UNAUTHORIZED_SIGNER"
      );
    });

    it("rejects a signature made by a different key than the claimed signer", async () => {
      const p = await proposeUsdc();
      await expectCode(service.approve(p.id, adminB.publicKey(), sign(p, "APPROVE", adminA)), "INVALID_SIGNATURE");
    });

    it("rejects garbage and truncated signatures", async () => {
      const p = await proposeUsdc();
      await expectCode(service.approve(p.id, adminA.publicKey(), "not-base64!!"), "INVALID_SIGNATURE");
      await expectCode(service.approve(p.id, adminA.publicKey(), Buffer.alloc(10).toString("base64")), "INVALID_SIGNATURE");
    });

    it("rejects signatures replayed from another action, proposal or network", async () => {
      const p = await proposeUsdc();
      const other = await proposeUsdc("1.0000000");
      await expectCode(service.approve(p.id, adminA.publicKey(), sign(p, "CANCEL", adminA)), "INVALID_SIGNATURE");
      await expectCode(service.approve(p.id, adminA.publicKey(), sign(other, "APPROVE", adminA)), "INVALID_SIGNATURE");
      await expectCode(
        service.approve(p.id, adminA.publicKey(), sign(p, "APPROVE", adminA, Networks.PUBLIC)),
        "INVALID_SIGNATURE"
      );
    });

    it("refuses execution when stored approvals were tampered with", async () => {
      const p = await queuedProposal();
      const stored = (await store.get(p.id))!;
      stored.approvals[1].signature = stored.approvals[0].signature;
      await store.save(stored);

      advance(TREASURY_TIMELOCK_MS);
      await expectCode(service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA)), "THRESHOLD_NOT_MET");
      assert.equal(executor.calls.length, 0);
    });
  });

  describe("timelock bounds", () => {
    it("blocks execution one millisecond before the timelock elapses", async () => {
      const p = await queuedProposal();
      advance(TREASURY_TIMELOCK_MS - 1);
      await expectCode(service.execute(p.id, adminC.publicKey(), sign(p, "EXECUTE", adminC)), "TIMELOCK_ACTIVE");
      assert.equal(executor.calls.length, 0);
    });

    it("executes exactly when the timelock elapses and records the transaction", async () => {
      const p = await queuedProposal();
      advance(TREASURY_TIMELOCK_MS);
      const executed = await service.execute(p.id, adminC.publicKey(), sign(p, "EXECUTE", adminC));
      assert.equal(executed.status, "EXECUTED");
      assert.equal(executed.transactionHash, "tx-1");
      assert.equal(executor.calls.length, 1);
      assert.equal(executor.calls[0].amount, "1500.5000000");
    });

    it("cannot execute twice", async () => {
      const p = await queuedProposal();
      advance(TREASURY_TIMELOCK_MS);
      await service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA));
      await expectCode(service.execute(p.id, adminB.publicKey(), sign(p, "EXECUTE", adminB)), "INVALID_STATE");
      assert.equal(executor.calls.length, 1);
    });

    it("serializes concurrent execution attempts so funds move once", async () => {
      const p = await queuedProposal();
      advance(TREASURY_TIMELOCK_MS);
      const results = await Promise.allSettled([
        service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA)),
        service.execute(p.id, adminB.publicKey(), sign(p, "EXECUTE", adminB)),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(executor.calls.length, 1);
    });

    it("expires a queued withdrawal after the execution grace period", async () => {
      const p = await queuedProposal();
      advance(TREASURY_TIMELOCK_MS + 7 * 24 * HOUR + 1);
      await expectCode(service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA)), "EXPIRED");
      assert.equal((await service.getProposal(p.id))!.status, "EXPIRED");
    });

    it("expires a proposal that never reaches the threshold within the approval window", async () => {
      const p = await proposeUsdc();
      advance(7 * 24 * HOUR + 1);
      await expectCode(service.approve(p.id, adminA.publicKey(), sign(p, "APPROVE", adminA)), "INVALID_STATE");
      assert.equal((await service.getProposal(p.id))!.status, "EXPIRED");
    });

    it("returns to QUEUED and audits the failure when submission fails", async () => {
      const p = await queuedProposal();
      advance(TREASURY_TIMELOCK_MS);
      executor.fail = true;
      await assert.rejects(service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA)), /horizon unavailable/);
      assert.equal((await service.getProposal(p.id))!.status, "QUEUED");
      assert.ok(auditLog.getChain().some((e) => e.action === "TREASURY_WITHDRAWAL_EXECUTION_FAILED"));
    });
  });

  describe("cancellation", () => {
    it("any administrator can cancel during the timelock window", async () => {
      const p = await queuedProposal();
      advance(TREASURY_TIMELOCK_MS / 2);
      const cancelled = await service.cancel(p.id, adminC.publicKey(), sign(p, "CANCEL", adminC), "suspicious");
      assert.equal(cancelled.status, "CANCELLED");
      assert.equal(cancelled.cancelledBy, adminC.publicKey());

      advance(TREASURY_TIMELOCK_MS);
      await expectCode(service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA)), "INVALID_STATE");
      assert.equal(executor.calls.length, 0);
    });

    it("can cancel before the threshold is reached", async () => {
      const p = await proposeUsdc();
      const cancelled = await service.cancel(p.id, adminB.publicKey(), sign(p, "CANCEL", adminB));
      assert.equal(cancelled.status, "CANCELLED");
    });

    it("rejects cancellation by non-administrators or without a valid signature", async () => {
      const p = await queuedProposal();
      await expectCode(service.cancel(p.id, outsider.publicKey(), sign(p, "CANCEL", outsider)), "UNAUTHORIZED_SIGNER");
      await expectCode(service.cancel(p.id, adminA.publicKey(), sign(p, "APPROVE", adminA)), "INVALID_SIGNATURE");
      assert.equal((await service.getProposal(p.id))!.status, "QUEUED");
    });

    it("cannot cancel an executed withdrawal", async () => {
      const p = await queuedProposal();
      advance(TREASURY_TIMELOCK_MS);
      await service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA));
      await expectCode(service.cancel(p.id, adminB.publicKey(), sign(p, "CANCEL", adminB)), "INVALID_STATE");
    });
  });

  describe("audit trail", () => {
    it("records every signature and step in a verifiable hash chain", async () => {
      const p = await queuedProposal();
      await expectCode(service.approve(p.id, outsider.publicKey(), sign(p, "APPROVE", outsider)), "UNAUTHORIZED_SIGNER");
      advance(TREASURY_TIMELOCK_MS);
      await service.execute(p.id, adminA.publicKey(), sign(p, "EXECUTE", adminA));

      const actions = auditLog.getChain().map((e) => e.action);
      assert.deepEqual(actions, [
        "TREASURY_WITHDRAWAL_PROPOSED",
        "TREASURY_WITHDRAWAL_APPROVED",
        "TREASURY_WITHDRAWAL_APPROVED",
        "TREASURY_WITHDRAWAL_QUEUED",
        "TREASURY_WITHDRAWAL_REJECTED",
        "TREASURY_WITHDRAWAL_EXECUTION_STARTED",
        "TREASURY_WITHDRAWAL_EXECUTED",
      ]);

      const approvals = auditLog.getChain().filter((e) => e.action === "TREASURY_WITHDRAWAL_APPROVED");
      assert.deepEqual(
        approvals.map((e) => e.actorId),
        [adminA.publicKey(), adminB.publicKey()]
      );
      assert.ok(approvals.every((e) => typeof e.payload.signature === "string"));
      assert.equal(auditLog.verify().valid, true);
    });
  });
});

describe("StellarTreasuryWithdrawalExecutor (issue #262)", () => {
  it("builds, signs with the treasury key and submits a payment", async () => {
    const treasury = Keypair.random();
    let submitted: Transaction | null = null;
    const executor = new StellarTreasuryWithdrawalExecutor({
      treasuryKeyReference: treasury.secret(),
      signer: new LocalSecretTransactionSigner(),
      networkPassphrase: NETWORK,
      horizon: {
        loadAccount: async (id) => new Account(id, "100"),
        submitTransaction: async (tx) => {
          submitted = tx;
          return { hash: Buffer.from(tx.hash()).toString("hex") };
        },
      },
    });

    const result = await executor.execute({
      id: "p1",
      destination,
      amount: "25.0000000",
      asset: { code: "USDC", issuer: usdcIssuer },
      memo: "cold storage",
      proposedBy: treasury.publicKey(),
      createdAt: new Date().toISOString(),
      status: "EXECUTING",
      approvals: [],
    });

    assert.ok(submitted);
    const tx = TransactionBuilder.fromXDR((submitted as Transaction).toXDR(), NETWORK) as Transaction;
    assert.equal(tx.source, treasury.publicKey());
    assert.equal(tx.operations.length, 1);
    const op = tx.operations[0] as any;
    assert.equal(op.type, "payment");
    assert.equal(op.destination, destination);
    assert.equal(op.amount, "25.0000000");
    assert.equal(op.asset.code, "USDC");
    assert.equal(tx.signatures.length, 1);
    const signature = (tx.signatures[0] as any).signature.value;
    assert.ok(treasury.verify(tx.hash(), Buffer.from(signature)));
    assert.equal(result.transactionHash, Buffer.from(tx.hash()).toString("hex"));
  });
});
