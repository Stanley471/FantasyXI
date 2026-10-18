import crypto from "crypto";
import {
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  CryptographicAuditLog,
  canonicalizePayload,
  cryptoAuditLog,
} from "../audit/cryptoAuditLog.js";
import type { StellarTransactionSigner } from "./transactionSigner.js";

/**
 * Treasury Multi-Signature Withdrawal Timelock (issue #262).
 *
 * Moving the platform-fee treasury requires:
 *   1. A withdrawal proposal created by a treasury administrator.
 *   2. M-of-N Ed25519 approvals from distinct administrator Stellar keys. Each
 *      approval signs a SHA-256 digest of the canonical proposal, bound to the
 *      action and the Stellar network passphrase, so a signature cannot be
 *      replayed for another proposal, another action or another network.
 *   3. A timelock of at least 48 hours that starts once the threshold is met.
 *      Any administrator may cancel (with a signed cancellation) until the
 *      withdrawal is executed.
 *   4. Execution by an administrator (signed) after the timelock and before
 *      the execution grace period lapses. Every stored approval is re-verified
 *      immediately before funds move.
 *
 * Every accepted signature, state transition and rejected attempt is appended
 * to the CryptographicAuditLog hash chain.
 */

export const TREASURY_TIMELOCK_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_APPROVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_EXECUTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** A single compromised key must never be able to move treasury funds. */
export const MIN_TREASURY_THRESHOLD = 2;

const SIGNING_DOMAIN = "FantasyXI:treasury-withdrawal:v1";
const AUDIT_ENTITY = "TREASURY_WITHDRAWAL";

export type WithdrawalStatus =
  | "PENDING_APPROVAL"
  | "QUEUED"
  | "EXECUTING"
  | "EXECUTED"
  | "CANCELLED"
  | "EXPIRED";

export type WithdrawalAction = "APPROVE" | "CANCEL" | "EXECUTE";

export interface WithdrawalAsset {
  /** "XLM" (with no issuer) for lumens, otherwise a credit asset code */
  code: string;
  issuer?: string;
}

export interface WithdrawalRequest {
  destination: string;
  /** Decimal string with up to 7 fractional digits (Stellar precision) */
  amount: string;
  asset: WithdrawalAsset;
  memo?: string;
}

export interface WithdrawalApproval {
  signer: string;
  signature: string;
  approvedAt: string;
}

export interface WithdrawalProposal extends WithdrawalRequest {
  id: string;
  proposedBy: string;
  createdAt: string;
  status: WithdrawalStatus;
  approvals: WithdrawalApproval[];
  queuedAt?: string;
  executableAt?: string;
  expiresAt?: string;
  cancelledBy?: string;
  cancelledAt?: string;
  cancelReason?: string;
  executedBy?: string;
  executedAt?: string;
  transactionHash?: string;
}

export type TreasuryTimelockErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHORIZED_SIGNER"
  | "INVALID_SIGNATURE"
  | "DUPLICATE_APPROVAL"
  | "INVALID_STATE"
  | "THRESHOLD_NOT_MET"
  | "TIMELOCK_ACTIVE"
  | "EXPIRED";

export class TreasuryTimelockError extends Error {
  constructor(
    public readonly code: TreasuryTimelockErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TreasuryTimelockError";
  }
}

/** Persistence for proposals; the default keeps them in memory. */
export interface TreasuryProposalStore {
  get(id: string): Promise<WithdrawalProposal | null>;
  save(proposal: WithdrawalProposal): Promise<void>;
  list(): Promise<WithdrawalProposal[]>;
}

export class InMemoryTreasuryProposalStore implements TreasuryProposalStore {
  private readonly proposals = new Map<string, WithdrawalProposal>();

  public async get(id: string): Promise<WithdrawalProposal | null> {
    const found = this.proposals.get(id);
    return found ? structuredClone(found) : null;
  }

  public async save(proposal: WithdrawalProposal): Promise<void> {
    this.proposals.set(proposal.id, structuredClone(proposal));
  }

  public async list(): Promise<WithdrawalProposal[]> {
    return [...this.proposals.values()].map((p) => structuredClone(p));
  }
}

/** Moves the funds once a proposal is cleared for execution. */
export interface TreasuryWithdrawalExecutor {
  execute(proposal: Readonly<WithdrawalProposal>): Promise<{ transactionHash: string }>;
}

export interface TreasuryTimelockConfig {
  /** Stellar public keys (G...) of the N treasury administrators */
  adminPublicKeys: string[];
  /** M: approvals required before the timelock starts */
  threshold: number;
  networkPassphrase: string;
  executor: TreasuryWithdrawalExecutor;
  /** Defaults to 48 hours; shorter values are rejected */
  timelockMs?: number;
  approvalWindowMs?: number;
  executionGraceMs?: number;
  store?: TreasuryProposalStore;
  auditLog?: CryptographicAuditLog;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * The digest an administrator signs to authorize `action` on a proposal. Only
 * the immutable proposal fields are covered, so approvals stay valid as the
 * proposal's status changes.
 */
export function withdrawalSigningPayload(
  proposal: Pick<
    WithdrawalProposal,
    "id" | "destination" | "amount" | "asset" | "memo" | "proposedBy" | "createdAt"
  >,
  action: WithdrawalAction,
  networkPassphrase: string
): Buffer {
  const body = canonicalizePayload({
    id: proposal.id,
    destination: proposal.destination,
    amount: proposal.amount,
    asset: { code: proposal.asset.code, issuer: proposal.asset.issuer ?? null },
    memo: proposal.memo ?? null,
    proposedBy: proposal.proposedBy,
    createdAt: proposal.createdAt,
    networkPassphrase,
  });
  return crypto.createHash("sha256").update(`${SIGNING_DOMAIN}|${action}|${body}`, "utf8").digest();
}

/** Signs `action` for a proposal with an administrator key (base64 signature). */
export function signWithdrawalAction(
  proposal: Parameters<typeof withdrawalSigningPayload>[0],
  action: WithdrawalAction,
  keypair: Keypair,
  networkPassphrase: string
): string {
  return Buffer.from(keypair.sign(withdrawalSigningPayload(proposal, action, networkPassphrase))).toString(
    "base64"
  );
}

function verifySignature(publicKey: string, payload: Buffer, signature: string): boolean {
  try {
    const raw = Buffer.from(signature, "base64");
    return raw.length === 64 && Keypair.fromPublicKey(publicKey).verify(payload, raw);
  } catch {
    return false;
  }
}

const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,7})?$/;
const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;

function validateRequest(request: WithdrawalRequest): void {
  if (!request || typeof request !== "object") {
    throw new TreasuryTimelockError("INVALID_REQUEST", "Withdrawal request is required");
  }
  if (typeof request.destination !== "string" || !StrKey.isValidEd25519PublicKey(request.destination)) {
    throw new TreasuryTimelockError("INVALID_REQUEST", "destination must be a valid Stellar public key");
  }
  if (typeof request.amount !== "string" || !AMOUNT_PATTERN.test(request.amount) || !(Number(request.amount) > 0)) {
    throw new TreasuryTimelockError(
      "INVALID_REQUEST",
      "amount must be a positive decimal string with at most 7 fractional digits"
    );
  }
  const asset = request.asset;
  if (!asset || typeof asset.code !== "string" || !ASSET_CODE_PATTERN.test(asset.code)) {
    throw new TreasuryTimelockError("INVALID_REQUEST", "asset.code must be 1-12 alphanumeric characters");
  }
  const isNative = asset.code === "XLM" && !asset.issuer;
  if (!isNative && (typeof asset.issuer !== "string" || !StrKey.isValidEd25519PublicKey(asset.issuer))) {
    throw new TreasuryTimelockError("INVALID_REQUEST", "asset.issuer must be a valid Stellar public key");
  }
  if (request.memo !== undefined && (typeof request.memo !== "string" || Buffer.byteLength(request.memo, "utf8") > 28)) {
    throw new TreasuryTimelockError("INVALID_REQUEST", "memo must be a string of at most 28 bytes");
  }
}

export class TreasuryTimelockService {
  private readonly admins: ReadonlySet<string>;
  private readonly threshold: number;
  private readonly networkPassphrase: string;
  private readonly executor: TreasuryWithdrawalExecutor;
  private readonly timelockMs: number;
  private readonly approvalWindowMs: number;
  private readonly executionGraceMs: number;
  private readonly store: TreasuryProposalStore;
  private readonly auditLog: CryptographicAuditLog;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(config: TreasuryTimelockConfig) {
    const keys = config.adminPublicKeys ?? [];
    for (const key of keys) {
      if (!StrKey.isValidEd25519PublicKey(key)) {
        throw new TreasuryTimelockError("INVALID_CONFIG", `Invalid administrator public key: ${key}`);
      }
    }
    if (new Set(keys).size !== keys.length) {
      throw new TreasuryTimelockError("INVALID_CONFIG", "Administrator public keys must be unique");
    }
    if (
      !Number.isInteger(config.threshold) ||
      config.threshold < MIN_TREASURY_THRESHOLD ||
      config.threshold > keys.length
    ) {
      throw new TreasuryTimelockError(
        "INVALID_CONFIG",
        `threshold must be an integer between ${MIN_TREASURY_THRESHOLD} and the number of administrators (${keys.length})`
      );
    }
    const timelockMs = config.timelockMs ?? TREASURY_TIMELOCK_MS;
    if (timelockMs < TREASURY_TIMELOCK_MS) {
      throw new TreasuryTimelockError("INVALID_CONFIG", "timelockMs cannot be shorter than 48 hours");
    }
    if (!config.networkPassphrase) {
      throw new TreasuryTimelockError("INVALID_CONFIG", "networkPassphrase is required");
    }

    this.admins = new Set(keys);
    this.threshold = config.threshold;
    this.networkPassphrase = config.networkPassphrase;
    this.executor = config.executor;
    this.timelockMs = timelockMs;
    this.approvalWindowMs = config.approvalWindowMs ?? DEFAULT_APPROVAL_WINDOW_MS;
    this.executionGraceMs = config.executionGraceMs ?? DEFAULT_EXECUTION_GRACE_MS;
    this.store = config.store ?? new InMemoryTreasuryProposalStore();
    this.auditLog = config.auditLog ?? cryptoAuditLog;
    this.now = config.now ?? (() => new Date());
    this.generateId = config.generateId ?? (() => crypto.randomUUID());
  }

  public getThreshold(): number {
    return this.threshold;
  }

  public async getProposal(id: string): Promise<WithdrawalProposal | null> {
    return this.store.get(id);
  }

  public async listProposals(): Promise<WithdrawalProposal[]> {
    return this.store.list();
  }

  /** The digest an administrator must sign to authorize `action` on proposal `id`. */
  public async getSigningPayload(id: string, action: WithdrawalAction): Promise<Buffer> {
    return withdrawalSigningPayload(await this.load(id), action, this.networkPassphrase);
  }

  /**
   * Creates a withdrawal proposal. Proposing moves no funds, so the proposer
   * only needs to be an administrator; approvals are collected separately.
   */
  public async propose(request: WithdrawalRequest, proposedBy: string): Promise<WithdrawalProposal> {
    this.requireAdmin(proposedBy, "PROPOSE", "new");
    validateRequest(request);

    const proposal: WithdrawalProposal = {
      id: this.generateId(),
      destination: request.destination,
      amount: request.amount,
      asset: request.asset.issuer
        ? { code: request.asset.code, issuer: request.asset.issuer }
        : { code: request.asset.code },
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
      proposedBy,
      createdAt: this.now().toISOString(),
      status: "PENDING_APPROVAL",
      approvals: [],
    };

    await this.store.save(proposal);
    this.audit("TREASURY_WITHDRAWAL_PROPOSED", proposedBy, proposal.id, {
      destination: proposal.destination,
      amount: proposal.amount,
      asset: proposal.asset,
      memo: proposal.memo ?? null,
      threshold: this.threshold,
    });
    return proposal;
  }

  /** Records an administrator's signed approval; queues the timelock at M approvals. */
  public async approve(id: string, signer: string, signature: string): Promise<WithdrawalProposal> {
    return this.withLock(id, async () => {
      const proposal = await this.load(id);
      this.requireAdmin(signer, "APPROVE", id);
      this.expireIfStale(proposal);

      if (proposal.status !== "PENDING_APPROVAL") {
        await this.persistIfExpired(proposal);
        this.reject("INVALID_STATE", signer, id, "APPROVE", `Proposal is ${proposal.status}; approvals are closed`);
      }
      if (proposal.approvals.some((a) => a.signer === signer)) {
        this.reject("DUPLICATE_APPROVAL", signer, id, "APPROVE", "Administrator has already approved this proposal");
      }
      this.requireSignature(proposal, "APPROVE", signer, signature);

      const now = this.now();
      proposal.approvals.push({ signer, signature, approvedAt: now.toISOString() });
      this.audit("TREASURY_WITHDRAWAL_APPROVED", signer, id, {
        signature,
        approvals: proposal.approvals.length,
        threshold: this.threshold,
      });

      if (proposal.approvals.length >= this.threshold) {
        const executableAt = new Date(now.getTime() + this.timelockMs);
        proposal.status = "QUEUED";
        proposal.queuedAt = now.toISOString();
        proposal.executableAt = executableAt.toISOString();
        proposal.expiresAt = new Date(executableAt.getTime() + this.executionGraceMs).toISOString();
        this.audit("TREASURY_WITHDRAWAL_QUEUED", signer, id, {
          executableAt: proposal.executableAt,
          expiresAt: proposal.expiresAt,
          approvers: proposal.approvals.map((a) => a.signer),
        });
      }

      await this.store.save(proposal);
      return proposal;
    });
  }

  /** Any administrator may cancel a proposal that has not been executed. */
  public async cancel(
    id: string,
    signer: string,
    signature: string,
    reason?: string
  ): Promise<WithdrawalProposal> {
    return this.withLock(id, async () => {
      const proposal = await this.load(id);
      this.requireAdmin(signer, "CANCEL", id);

      if (proposal.status !== "PENDING_APPROVAL" && proposal.status !== "QUEUED") {
        this.reject("INVALID_STATE", signer, id, "CANCEL", `Proposal is ${proposal.status} and can no longer be cancelled`);
      }
      this.requireSignature(proposal, "CANCEL", signer, signature);

      proposal.status = "CANCELLED";
      proposal.cancelledBy = signer;
      proposal.cancelledAt = this.now().toISOString();
      if (reason) proposal.cancelReason = reason;

      await this.store.save(proposal);
      this.audit("TREASURY_WITHDRAWAL_CANCELLED", signer, id, { signature, reason: reason ?? null });
      return proposal;
    });
  }

  /**
   * Executes a queued withdrawal once the timelock has elapsed. Stored
   * approvals are re-verified against the configured administrators first, so
   * a tampered store cannot release funds.
   */
  public async execute(id: string, signer: string, signature: string): Promise<WithdrawalProposal> {
    return this.withLock(id, async () => {
      const proposal = await this.load(id);
      this.requireAdmin(signer, "EXECUTE", id);
      this.expireIfStale(proposal);

      if (proposal.status === "EXPIRED") {
        await this.persistIfExpired(proposal);
        this.reject("EXPIRED", signer, id, "EXECUTE", "Execution grace period has lapsed");
      }
      if (proposal.status === "PENDING_APPROVAL") {
        this.reject(
          "THRESHOLD_NOT_MET",
          signer,
          id,
          "EXECUTE",
          `Proposal has ${proposal.approvals.length} of ${this.threshold} required approvals`
        );
      }
      if (proposal.status !== "QUEUED") {
        this.reject("INVALID_STATE", signer, id, "EXECUTE", `Proposal is ${proposal.status}`);
      }

      const now = this.now();
      if (now.getTime() < new Date(proposal.executableAt!).getTime()) {
        this.reject("TIMELOCK_ACTIVE", signer, id, "EXECUTE", `Timelock active until ${proposal.executableAt}`);
      }
      this.requireSignature(proposal, "EXECUTE", signer, signature);

      const validApprovers = new Set(
        proposal.approvals
          .filter(
            (a) =>
              this.admins.has(a.signer) &&
              verifySignature(
                a.signer,
                withdrawalSigningPayload(proposal, "APPROVE", this.networkPassphrase),
                a.signature
              )
          )
          .map((a) => a.signer)
      );
      if (validApprovers.size < this.threshold) {
        this.reject(
          "THRESHOLD_NOT_MET",
          signer,
          id,
          "EXECUTE",
          `Only ${validApprovers.size} of ${this.threshold} stored approvals verify`
        );
      }

      proposal.status = "EXECUTING";
      await this.store.save(proposal);
      this.audit("TREASURY_WITHDRAWAL_EXECUTION_STARTED", signer, id, { signature });

      try {
        const { transactionHash } = await this.executor.execute(proposal);
        proposal.status = "EXECUTED";
        proposal.executedBy = signer;
        proposal.executedAt = this.now().toISOString();
        proposal.transactionHash = transactionHash;
        await this.store.save(proposal);
        this.audit("TREASURY_WITHDRAWAL_EXECUTED", signer, id, { transactionHash });
        return proposal;
      } catch (err) {
        proposal.status = "QUEUED";
        await this.store.save(proposal);
        this.audit("TREASURY_WITHDRAWAL_EXECUTION_FAILED", signer, id, {
          error: (err as Error).message,
        });
        throw err;
      }
    });
  }

  private async load(id: string): Promise<WithdrawalProposal> {
    const proposal = await this.store.get(id);
    if (!proposal) {
      throw new TreasuryTimelockError("NOT_FOUND", `Withdrawal proposal ${id} not found`);
    }
    return proposal;
  }

  private expireIfStale(proposal: WithdrawalProposal): void {
    const now = this.now().getTime();
    const approvalDeadline = new Date(proposal.createdAt).getTime() + this.approvalWindowMs;
    if (
      (proposal.status === "PENDING_APPROVAL" && now > approvalDeadline) ||
      (proposal.status === "QUEUED" && now > new Date(proposal.expiresAt!).getTime())
    ) {
      proposal.status = "EXPIRED";
    }
  }

  private async persistIfExpired(proposal: WithdrawalProposal): Promise<void> {
    const stored = await this.store.get(proposal.id);
    if (proposal.status === "EXPIRED" && stored?.status !== "EXPIRED") {
      await this.store.save(proposal);
      this.audit("TREASURY_WITHDRAWAL_EXPIRED", "system", proposal.id, {});
    }
  }

  private requireAdmin(signer: string, action: string, id: string): void {
    if (!this.admins.has(signer)) {
      this.reject("UNAUTHORIZED_SIGNER", signer, id, action, "Signer is not a treasury administrator");
    }
  }

  private requireSignature(
    proposal: WithdrawalProposal,
    action: WithdrawalAction,
    signer: string,
    signature: string
  ): void {
    const payload = withdrawalSigningPayload(proposal, action, this.networkPassphrase);
    if (typeof signature !== "string" || !verifySignature(signer, payload, signature)) {
      this.reject("INVALID_SIGNATURE", signer, proposal.id, action, "Ed25519 signature verification failed");
    }
  }

  private reject(
    code: TreasuryTimelockErrorCode,
    actor: string,
    id: string,
    action: string,
    message: string
  ): never {
    this.audit("TREASURY_WITHDRAWAL_REJECTED", String(actor), id, { action, code, message });
    throw new TreasuryTimelockError(code, message);
  }

  private audit(action: string, actorId: string, entityId: string, payload: Record<string, unknown>): void {
    this.auditLog.record(action, actorId, AUDIT_ENTITY, entityId, payload);
  }

  /** Serializes mutations per proposal so concurrent approvals cannot be lost. */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.locks.set(id, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === run) this.locks.delete(id);
    }
  }
}

/** Horizon operations the Stellar executor needs (Horizon.Server satisfies this). */
export interface TreasuryHorizonClient {
  loadAccount(accountId: string): Promise<Account>;
  submitTransaction(transaction: Transaction): Promise<{ hash: string }>;
}

export interface StellarTreasuryExecutorOptions {
  /** Key reference handed to the signer (secret for local signing, key id for KMS/HSM) */
  treasuryKeyReference: string;
  signer: StellarTransactionSigner;
  horizon: TreasuryHorizonClient;
  networkPassphrase: string;
  fee?: string;
  timeoutSeconds?: number;
}

/** Submits an approved withdrawal as a Stellar payment signed by the treasury key. */
export class StellarTreasuryWithdrawalExecutor implements TreasuryWithdrawalExecutor {
  constructor(private readonly options: StellarTreasuryExecutorOptions) {}

  public async execute(proposal: Readonly<WithdrawalProposal>): Promise<{ transactionHash: string }> {
    const { signer, treasuryKeyReference, horizon } = this.options;
    const source = await signer.publicKey(treasuryKeyReference);
    const account = await horizon.loadAccount(source);
    const asset =
      proposal.asset.code === "XLM" && !proposal.asset.issuer
        ? Asset.native()
        : new Asset(proposal.asset.code, proposal.asset.issuer);

    const builder = new TransactionBuilder(account, {
      fee: this.options.fee ?? BASE_FEE,
      networkPassphrase: this.options.networkPassphrase,
    })
      .addOperation(Operation.payment({ destination: proposal.destination, asset, amount: proposal.amount }))
      .setTimeout(this.options.timeoutSeconds ?? 180);
    if (proposal.memo) builder.addMemo(Memo.text(proposal.memo));

    const transaction = builder.build();
    await signer.sign(transaction, treasuryKeyReference);
    const result = await horizon.submitTransaction(transaction);
    return { transactionHash: result.hash };
  }
}
