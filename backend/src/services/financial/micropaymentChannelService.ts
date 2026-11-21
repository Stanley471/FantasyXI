/**
 * Off-Chain Micropayment Channel & Ledger Service (Issue #427)
 *
 * Enables low-latency (<50ms), zero-gas in-game microtransactions such as
 * mid-match tactical substitutions or emergency captain switches.
 *
 * Architecture:
 * 1. Channel Opening: Backed by an initial on-chain deposit (recorded in stroops,
 *    1 USDC = 10,000,000 stroops; sub-cent fees e.g. 0.001 USDC = 10,000 stroops).
 * 2. Off-Chain State Updates: In-memory / Redis state ledger validates ed25519
 *    cryptographic signatures over canonical state commitments:
 *      `FantasyXI:MicropaymentChannel:v1|channelId|gameweekId|sequence|cumulativeSpentStroops|actionType|payloadHash`
 *    Sequence numbers must increment monotonically (`nextSeq === currentSeq + 1`);
 *    older or duplicate state sequence replays are strictly rejected.
 * 3. Dispute Mechanism: Either party can challenge a channel during the dispute
 *    window by submitting a higher-sequence cryptographically signed state proof
 *    (participant signature and/or platform counter-signature). Fraudulent or stale
 *    states are superseded by the highest valid monotonic state sequence.
 * 4. Batch Settlement Worker: At gameweek finalization / deadline, reconciles and
 *    closes all active off-chain channels for the gameweek, committing final net
 *    balances (`cumulativeSpentStroops` to platform fee, `remainingDepositStroops`
 *    refunded/unlocked) to the primary database and smart contract settlement gateway.
 */

import crypto from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

export type MicropaymentActionType =
  | "LIVE_SUBSTITUTION"
  | "EMERGENCY_CAPTAIN_SWITCH"
  | "TACTICAL_FORMATION_SHIFT"
  | "CUSTOM_MICRO_ACTION";

export type MicropaymentChannelStatus =
  | "OPEN"
  | "DISPUTED"
  | "SETTLING"
  | "SETTLED"
  | "CLOSED";

export interface MicropaymentStateUpdateInput {
  channelId: string;
  sequence: number;
  incrementStroops: bigint | string | number;
  cumulativeSpentStroops: bigint | string | number;
  actionType: MicropaymentActionType;
  actionPayload: Record<string, unknown>;
  signature: string; // base64 or hex ed25519 signature by participant
  timestampMs?: number;
}

export interface SignedMicropaymentState {
  channelId: string;
  gameweekId: number;
  userId: string;
  participantAddress: string;
  sequence: number;
  incrementStroops: bigint;
  cumulativeSpentStroops: bigint;
  remainingBalanceStroops: bigint;
  actionType: MicropaymentActionType;
  payloadHash: string;
  actionPayload: Record<string, unknown>;
  participantSignature: string;
  platformCounterSignature: string;
  stateHash: string;
  updatedAtMs: number;
}

export interface MicropaymentDisputeRecord {
  disputeId: string;
  channelId: string;
  challengerAddress: string;
  submittedSequence: number;
  previousSequence: number;
  accepted: boolean;
  reason: string;
  resolvedCumulativeSpentStroops: bigint;
  resolvedRemainingBalanceStroops: bigint;
  createdAtMs: number;
}

export interface MicropaymentChannel {
  channelId: string;
  userId: string;
  squadId: string;
  gameweekId: number;
  participantAddress: string;
  depositTxHash: string;
  depositStroops: bigint;
  cumulativeSpentStroops: bigint;
  remainingBalanceStroops: bigint;
  sequence: number;
  status: MicropaymentChannelStatus;
  latestState: SignedMicropaymentState | null;
  stateHistory: SignedMicropaymentState[];
  disputes: MicropaymentDisputeRecord[];
  disputeWindowEndsAtMs: number | null;
  settlementTxHash: string | null;
  settledAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface OpenChannelInput {
  channelId?: string;
  userId: string;
  squadId: string;
  gameweekId: number;
  participantAddress: string;
  depositTxHash: string;
  depositStroops: bigint | string | number;
}

export interface DisputeSubmissionInput {
  channelId: string;
  challengerAddress: string;
  sequence: number;
  cumulativeSpentStroops: bigint | string | number;
  actionType: MicropaymentActionType;
  payloadHash: string;
  participantSignature: string;
  platformCounterSignature?: string;
}

export interface ChannelSettlementCommitRecord {
  channelId: string;
  userId: string;
  squadId: string;
  gameweekId: number;
  participantAddress: string;
  depositTxHash: string;
  depositStroops: string;
  finalSpentStroops: string;
  refundStroops: string;
  finalSequence: number;
  finalStateHash: string;
  settlementTxHash: string;
  settledAt: Date;
}

export interface BatchSettlementResult {
  gameweekId: number;
  settledCount: number;
  failedCount: number;
  totalCollectedFeeStroops: bigint;
  totalRefundedStroops: bigint;
  settlements: ChannelSettlementCommitRecord[];
  errors: Array<{ channelId: string; error: string }>;
}

export interface MicropaymentSettlementGateway {
  commitChannelSettlementOnChain(params: {
    channelId: string;
    gameweekId: number;
    participantAddress: string;
    depositStroops: bigint;
    finalSpentStroops: bigint;
    refundStroops: bigint;
    finalSequence: number;
    finalStateHash: string;
  }): Promise<{ success: boolean; txHash?: string; error?: string }>;
}

export interface MicropaymentDatabasePersistence {
  persistChannelSettlement(record: ChannelSettlementCommitRecord): Promise<void>;
}

export class MicropaymentChannelError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CHANNEL_NOT_FOUND"
      | "CHANNEL_ALREADY_EXISTS"
      | "CHANNEL_NOT_OPEN"
      | "INVALID_DEPOSIT"
      | "STALE_SEQUENCE_REPLAY"
      | "NON_MONOTONIC_SEQUENCE"
      | "INSUFFICIENT_CHANNEL_BALANCE"
      | "INVALID_INCREMENT"
      | "INVALID_SIGNATURE"
      | "DISPUTE_REJECTED"
      | "SETTLEMENT_FAILED",
    public readonly statusCode: 400 | 401 | 403 | 404 | 409 | 422 | 502 = 400
  ) {
    super(message);
    this.name = "MicropaymentChannelError";
  }
}

/** Default sub-cent fee schedules in stroops (1 USDC = 10^7 stroops; 1 cent = 100,000 stroops). */
export const MICROPAYMENT_FEE_SCHEDULE_STROOPS: Record<MicropaymentActionType, bigint> = {
  LIVE_SUBSTITUTION: 25_000n, // 0.0025 USDC (0.25 cents)
  EMERGENCY_CAPTAIN_SWITCH: 50_000n, // 0.0050 USDC (0.50 cents)
  TACTICAL_FORMATION_SHIFT: 15_000n, // 0.0015 USDC (0.15 cents)
  CUSTOM_MICRO_ACTION: 10_000n, // 0.0010 USDC (0.10 cents)
};

const DOMAIN_SEPARATOR = "FantasyXI:MicropaymentChannel:v1";
const DEFAULT_DISPUTE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function toStroopsBigInt(value: bigint | string | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new MicropaymentChannelError(
        "Stroop amount must be an integer",
        "INVALID_INCREMENT",
        400
      );
    }
    return BigInt(value);
  }
  const trimmed = String(value).trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new MicropaymentChannelError(
      `Invalid stroop integer representation: ${value}`,
      "INVALID_INCREMENT",
      400
    );
  }
  return BigInt(trimmed);
}

export function hashActionPayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    normalized[key] = payload[key];
  }
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Builds the canonical state commitment message signed by the participant wallet
 * and counter-signed by the platform sequencer.
 */
export function buildMicropaymentStateMessage(params: {
  channelId: string;
  gameweekId: number;
  sequence: number;
  cumulativeSpentStroops: bigint | string | number;
  actionType: MicropaymentActionType;
  payloadHash: string;
}): string {
  const spent = toStroopsBigInt(params.cumulativeSpentStroops);
  return `${DOMAIN_SEPARATOR}|${params.channelId}|${params.gameweekId}|${params.sequence}|${spent.toString()}|${params.actionType}|${params.payloadHash}`;
}

export function computeStateHash(message: string): string {
  return crypto.createHash("sha256").update(message, "utf8").digest("hex");
}

function decodeSignatureBytes(signature: string): Buffer | null {
  const trimmed = signature.trim();
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === 64) return buf;
  } catch {
    return null;
  }
  return null;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const ed25519PublicKeyCache = new Map<string, crypto.KeyObject>();
const ed25519PrivateKeyCache = new Map<string, crypto.KeyObject>();

function getEd25519PublicKeyObject(publicKey: string): crypto.KeyObject {
  const clean = publicKey.trim();
  let cached = ed25519PublicKeyCache.get(clean);
  if (!cached) {
    const rawPubKey = StrKey.decodeEd25519PublicKey(clean);
    cached = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPubKey)]),
      format: "der",
      type: "spki",
    });
    ed25519PublicKeyCache.set(clean, cached);
  }
  return cached;
}

function getEd25519PrivateKeyObject(secret: string): crypto.KeyObject {
  const clean = secret.trim();
  let cached = ed25519PrivateKeyCache.get(clean);
  if (!cached) {
    const rawSeed = StrKey.decodeEd25519SecretSeed(clean);
    cached = crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(rawSeed)]),
      format: "der",
      type: "pkcs8",
    });
    ed25519PrivateKeyCache.set(clean, cached);
  }
  return cached;
}

export function verifyStellarEd25519Signature(
  publicKey: string,
  message: string,
  signature: string
): boolean {
  try {
    const sigBytes = decodeSignatureBytes(signature);
    if (!sigBytes || sigBytes.length !== 64) return false;
    const pubKeyObj = getEd25519PublicKeyObject(publicKey);
    return crypto.verify(null, Buffer.from(message, "utf8"), pubKeyObj, sigBytes);
  } catch {
    return false;
  }
}

export function signStellarEd25519Message(secretOrKeypair: string | Keypair, message: string): string {
  const secret =
    typeof secretOrKeypair === "string"
      ? secretOrKeypair
      : secretOrKeypair.secret();
  const privKeyObj = getEd25519PrivateKeyObject(secret);
  return crypto.sign(null, Buffer.from(message, "utf8"), privKeyObj).toString("base64");
}

export class MicropaymentChannelService {
  private readonly channels = new Map<string, MicropaymentChannel>();
  private readonly platformKeypair: Keypair;
  private readonly disputeWindowMs: number;
  private readonly settlementGateway: MicropaymentSettlementGateway;
  private readonly dbPersistence: MicropaymentDatabasePersistence;
  private readonly settledRecords: ChannelSettlementCommitRecord[] = [];

  constructor(options?: {
    platformKeypair?: Keypair;
    disputeWindowMs?: number;
    settlementGateway?: MicropaymentSettlementGateway;
    dbPersistence?: MicropaymentDatabasePersistence;
  }) {
    this.platformKeypair = options?.platformKeypair ?? Keypair.random();
    this.disputeWindowMs = options?.disputeWindowMs ?? DEFAULT_DISPUTE_WINDOW_MS;
    this.settlementGateway = options?.settlementGateway ?? {
      commitChannelSettlementOnChain: async (params) => ({
        success: true,
        txHash: crypto
          .createHash("sha256")
          .update(`settle:${params.channelId}:${params.finalSequence}:${params.finalStateHash}`)
          .digest("hex"),
      }),
    };
    this.dbPersistence = options?.dbPersistence ?? {
      persistChannelSettlement: async (record) => {
        this.settledRecords.push(record);
      },
    };
  }

  public getPlatformPublicKey(): string {
    return this.platformKeypair.publicKey();
  }

  public getSettledRecords(): ChannelSettlementCommitRecord[] {
    return [...this.settledRecords];
  }

  /**
   * Opens an off-chain micropayment channel backed by an initial on-chain deposit.
   */
  public openChannel(input: OpenChannelInput, nowMs: number = Date.now()): MicropaymentChannel {
    const depositStroops = toStroopsBigInt(input.depositStroops);
    if (depositStroops <= 0n) {
      throw new MicropaymentChannelError(
        "Initial on-chain deposit must be strictly positive",
        "INVALID_DEPOSIT",
        400
      );
    }

    try {
      Keypair.fromPublicKey(input.participantAddress);
    } catch {
      throw new MicropaymentChannelError(
        "participantAddress must be a valid Stellar ed25519 public key",
        "INVALID_DEPOSIT",
        400
      );
    }

    if (!input.depositTxHash || input.depositTxHash.trim().length < 8) {
      throw new MicropaymentChannelError(
        "A valid on-chain depositTxHash is required to open a micropayment channel",
        "INVALID_DEPOSIT",
        400
      );
    }

    const channelId =
      input.channelId ??
      `mpc_${input.gameweekId}_${input.userId}_${crypto.randomBytes(6).toString("hex")}`;

    if (this.channels.has(channelId)) {
      throw new MicropaymentChannelError(
        `Micropayment channel ${channelId} already exists`,
        "CHANNEL_ALREADY_EXISTS",
        409
      );
    }

    const channel: MicropaymentChannel = {
      channelId,
      userId: input.userId,
      squadId: input.squadId,
      gameweekId: input.gameweekId,
      participantAddress: input.participantAddress,
      depositTxHash: input.depositTxHash.trim(),
      depositStroops,
      cumulativeSpentStroops: 0n,
      remainingBalanceStroops: depositStroops,
      sequence: 0,
      status: "OPEN",
      latestState: null,
      stateHistory: [],
      disputes: [],
      disputeWindowEndsAtMs: null,
      settlementTxHash: null,
      settledAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };

    this.channels.set(channelId, channel);
    return channel;
  }

  public getChannel(channelId: string): MicropaymentChannel {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new MicropaymentChannelError(
        `Micropayment channel ${channelId} not found`,
        "CHANNEL_NOT_FOUND",
        404
      );
    }
    return channel;
  }

  public listChannelsForGameweek(gameweekId: number): MicropaymentChannel[] {
    const result: MicropaymentChannel[] = [];
    for (const channel of this.channels.values()) {
      if (channel.gameweekId === gameweekId) {
        result.push(channel);
      }
    }
    return result;
  }

  /**
   * Processes an instant off-chain micropayment state update (<50ms, zero-gas, no block wait).
   * Enforces strict monotonic sequence progression and rejects any stale state replay.
   */
  public applyStateUpdate(
    input: MicropaymentStateUpdateInput,
    nowMs: number = Date.now()
  ): SignedMicropaymentState {
    const channel = this.getChannel(input.channelId);

    if (channel.status !== "OPEN") {
      throw new MicropaymentChannelError(
        `Cannot apply micropayment update to channel in ${channel.status} state`,
        "CHANNEL_NOT_OPEN",
        409
      );
    }

    // 1. Sequence number monotonic check & replay defense
    if (!Number.isInteger(input.sequence) || input.sequence <= channel.sequence) {
      throw new MicropaymentChannelError(
        `Stale or replayed state sequence ${input.sequence} rejected (current sequence is ${channel.sequence})`,
        "STALE_SEQUENCE_REPLAY",
        409
      );
    }

    if (input.sequence !== channel.sequence + 1) {
      throw new MicropaymentChannelError(
        `State sequence must increment monotonically by 1: expected ${channel.sequence + 1}, received ${input.sequence}`,
        "NON_MONOTONIC_SEQUENCE",
        422
      );
    }

    // 2. Sub-cent balance increment validation
    const incrementStroops = toStroopsBigInt(input.incrementStroops);
    const cumulativeSpentStroops = toStroopsBigInt(input.cumulativeSpentStroops);

    if (incrementStroops <= 0n) {
      throw new MicropaymentChannelError(
        "Micropayment balance increment must be strictly positive",
        "INVALID_INCREMENT",
        400
      );
    }

    const expectedCumulative = channel.cumulativeSpentStroops + incrementStroops;
    if (cumulativeSpentStroops !== expectedCumulative) {
      throw new MicropaymentChannelError(
        `Cumulative balance mismatch: expected ${expectedCumulative.toString()} stroops, got ${cumulativeSpentStroops.toString()}`,
        "INVALID_INCREMENT",
        422
      );
    }

    if (cumulativeSpentStroops > channel.depositStroops) {
      throw new MicropaymentChannelError(
        `Insufficient micropayment channel balance: required ${cumulativeSpentStroops.toString()} stroops exceeds deposit ${channel.depositStroops.toString()}`,
        "INSUFFICIENT_CHANNEL_BALANCE",
        422
      );
    }

    // 3. Cryptographic signature verification
    const payloadHash = hashActionPayload(input.actionPayload);
    const message = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: channel.gameweekId,
      sequence: input.sequence,
      cumulativeSpentStroops,
      actionType: input.actionType,
      payloadHash,
    });

    const isValidSig = verifyStellarEd25519Signature(
      channel.participantAddress,
      message,
      input.signature
    );

    if (!isValidSig) {
      throw new MicropaymentChannelError(
        "Invalid participant signature on micropayment state update",
        "INVALID_SIGNATURE",
        401
      );
    }

    // 4. Platform counter-signature & atomic in-memory state transition
    const platformCounterSignature = signStellarEd25519Message(this.platformKeypair, message);
    const remainingBalanceStroops = channel.depositStroops - cumulativeSpentStroops;
    const stateHash = computeStateHash(message);
    const timestamp = input.timestampMs ?? nowMs;

    const signedState: SignedMicropaymentState = {
      channelId: channel.channelId,
      gameweekId: channel.gameweekId,
      userId: channel.userId,
      participantAddress: channel.participantAddress,
      sequence: input.sequence,
      incrementStroops,
      cumulativeSpentStroops,
      remainingBalanceStroops,
      actionType: input.actionType,
      payloadHash,
      actionPayload: input.actionPayload,
      participantSignature: input.signature,
      platformCounterSignature,
      stateHash,
      updatedAtMs: timestamp,
    };

    channel.sequence = input.sequence;
    channel.cumulativeSpentStroops = cumulativeSpentStroops;
    channel.remainingBalanceStroops = remainingBalanceStroops;
    channel.latestState = signedState;
    channel.stateHistory.push(signedState);
    channel.updatedAtMs = timestamp;

    return signedState;
  }

  /**
   * Dispute resolution mechanism using cryptographic state sequence numbers.
   *
   * Allows a participant or watchtower to submit a cryptographically signed state proof.
   * - If the submitted state has a strictly higher sequence number (`sequence > channel.sequence`)
   *   with a valid participant signature (and valid cumulative balance <= deposit),
   *   the channel state advances to that verified sequence.
   * - If the submitted state has `sequence <= channel.sequence`, it is rejected as stale/superseded.
   */
  public submitStateDispute(
    input: DisputeSubmissionInput,
    nowMs: number = Date.now()
  ): MicropaymentDisputeRecord {
    const channel = this.getChannel(input.channelId);

    if (channel.status === "SETTLED" || channel.status === "CLOSED") {
      throw new MicropaymentChannelError(
        `Cannot dispute a channel that is already ${channel.status}`,
        "CHANNEL_NOT_OPEN",
        409
      );
    }

    const submittedCumulative = toStroopsBigInt(input.cumulativeSpentStroops);
    if (submittedCumulative < 0n || submittedCumulative > channel.depositStroops) {
      throw new MicropaymentChannelError(
        "Disputed state cumulative balance is outside valid channel deposit bounds",
        "INVALID_INCREMENT",
        422
      );
    }

    const message = buildMicropaymentStateMessage({
      channelId: channel.channelId,
      gameweekId: channel.gameweekId,
      sequence: input.sequence,
      cumulativeSpentStroops: submittedCumulative,
      actionType: input.actionType,
      payloadHash: input.payloadHash,
    });

    const participantSigValid = verifyStellarEd25519Signature(
      channel.participantAddress,
      message,
      input.participantSignature
    );

    if (!participantSigValid) {
      throw new MicropaymentChannelError(
        "Dispute state proof has an invalid participant cryptographic signature",
        "INVALID_SIGNATURE",
        401
      );
    }

    if (input.platformCounterSignature) {
      const counterSigValid = verifyStellarEd25519Signature(
        this.platformKeypair.publicKey(),
        message,
        input.platformCounterSignature
      );
      if (!counterSigValid) {
        throw new MicropaymentChannelError(
          "Dispute state proof has an invalid platform counter-signature",
          "INVALID_SIGNATURE",
          401
        );
      }
    }

    const previousSequence = channel.sequence;

    if (input.sequence <= channel.sequence) {
      const rejectedRecord: MicropaymentDisputeRecord = {
        disputeId: `disp_${crypto.randomBytes(6).toString("hex")}`,
        channelId: channel.channelId,
        challengerAddress: input.challengerAddress,
        submittedSequence: input.sequence,
        previousSequence,
        accepted: false,
        reason: `Submitted state sequence ${input.sequence} is stale compared to active sequence ${channel.sequence}`,
        resolvedCumulativeSpentStroops: channel.cumulativeSpentStroops,
        resolvedRemainingBalanceStroops: channel.remainingBalanceStroops,
        createdAtMs: nowMs,
      };
      channel.disputes.push(rejectedRecord);
      throw new MicropaymentChannelError(
        rejectedRecord.reason,
        "DISPUTE_REJECTED",
        409
      );
    }

    // Valid higher-sequence state supersedes older state
    const platformCounterSignature =
      input.platformCounterSignature ?? signStellarEd25519Message(this.platformKeypair, message);
    const remainingBalanceStroops = channel.depositStroops - submittedCumulative;
    const incrementStroops =
      submittedCumulative >= channel.cumulativeSpentStroops
        ? submittedCumulative - channel.cumulativeSpentStroops
        : 0n;

    const recoveredState: SignedMicropaymentState = {
      channelId: channel.channelId,
      gameweekId: channel.gameweekId,
      userId: channel.userId,
      participantAddress: channel.participantAddress,
      sequence: input.sequence,
      incrementStroops,
      cumulativeSpentStroops: submittedCumulative,
      remainingBalanceStroops,
      actionType: input.actionType,
      payloadHash: input.payloadHash,
      actionPayload: { recoveredViaDispute: true },
      participantSignature: input.participantSignature,
      platformCounterSignature,
      stateHash: computeStateHash(message),
      updatedAtMs: nowMs,
    };

    channel.sequence = input.sequence;
    channel.cumulativeSpentStroops = submittedCumulative;
    channel.remainingBalanceStroops = remainingBalanceStroops;
    channel.latestState = recoveredState;
    channel.stateHistory.push(recoveredState);
    channel.status = "OPEN";
    channel.disputeWindowEndsAtMs = nowMs + this.disputeWindowMs;
    channel.updatedAtMs = nowMs;

    const acceptedRecord: MicropaymentDisputeRecord = {
      disputeId: `disp_${crypto.randomBytes(6).toString("hex")}`,
      channelId: channel.channelId,
      challengerAddress: input.challengerAddress,
      submittedSequence: input.sequence,
      previousSequence,
      accepted: true,
      reason: `State advanced to sequence ${input.sequence} via verified cryptographic proof`,
      resolvedCumulativeSpentStroops: channel.cumulativeSpentStroops,
      resolvedRemainingBalanceStroops: channel.remainingBalanceStroops,
      createdAtMs: nowMs,
    };

    channel.disputes.push(acceptedRecord);
    return acceptedRecord;
  }

  /**
   * Settles and closes a single channel, committing final net balances to the database and smart contract.
   */
  public async settleChannel(
    channelId: string,
    nowMs: number = Date.now()
  ): Promise<ChannelSettlementCommitRecord> {
    const channel = this.getChannel(channelId);

    if (channel.status === "SETTLED" || channel.status === "CLOSED") {
      throw new MicropaymentChannelError(
        `Channel ${channelId} is already settled`,
        "CHANNEL_NOT_OPEN",
        409
      );
    }

    channel.status = "SETTLING";
    const finalStateHash =
      channel.latestState?.stateHash ??
      computeStateHash(`${DOMAIN_SEPARATOR}|${channel.channelId}|${channel.gameweekId}|0|0|INIT|0`);

    const onChainResult = await this.settlementGateway.commitChannelSettlementOnChain({
      channelId: channel.channelId,
      gameweekId: channel.gameweekId,
      participantAddress: channel.participantAddress,
      depositStroops: channel.depositStroops,
      finalSpentStroops: channel.cumulativeSpentStroops,
      refundStroops: channel.remainingBalanceStroops,
      finalSequence: channel.sequence,
      finalStateHash,
    });

    if (!onChainResult.success || !onChainResult.txHash) {
      channel.status = "OPEN";
      throw new MicropaymentChannelError(
        onChainResult.error ?? "Smart contract settlement failed for micropayment channel",
        "SETTLEMENT_FAILED",
        502
      );
    }

    const commitRecord: ChannelSettlementCommitRecord = {
      channelId: channel.channelId,
      userId: channel.userId,
      squadId: channel.squadId,
      gameweekId: channel.gameweekId,
      participantAddress: channel.participantAddress,
      depositTxHash: channel.depositTxHash,
      depositStroops: channel.depositStroops.toString(),
      finalSpentStroops: channel.cumulativeSpentStroops.toString(),
      refundStroops: channel.remainingBalanceStroops.toString(),
      finalSequence: channel.sequence,
      finalStateHash,
      settlementTxHash: onChainResult.txHash,
      settledAt: new Date(nowMs),
    };

    await this.dbPersistence.persistChannelSettlement(commitRecord);

    channel.status = "SETTLED";
    channel.settlementTxHash = onChainResult.txHash;
    channel.settledAtMs = nowMs;
    channel.updatedAtMs = nowMs;

    return commitRecord;
  }

  /**
   * Batch settlement worker that reconciles and closes all open off-chain
   * micropayment channels for a gameweek upon deadline / finalization.
   */
  public async settleGameweekChannels(
    gameweekId: number,
    nowMs: number = Date.now()
  ): Promise<BatchSettlementResult> {
    const channels = this.listChannelsForGameweek(gameweekId).filter(
      (ch) => ch.status === "OPEN" || ch.status === "DISPUTED"
    );

    const settlements: ChannelSettlementCommitRecord[] = [];
    const errors: Array<{ channelId: string; error: string }> = [];
    let totalCollectedFeeStroops = 0n;
    let totalRefundedStroops = 0n;

    for (const channel of channels) {
      try {
        const record = await this.settleChannel(channel.channelId, nowMs);
        settlements.push(record);
        totalCollectedFeeStroops += BigInt(record.finalSpentStroops);
        totalRefundedStroops += BigInt(record.refundStroops);
      } catch (err: unknown) {
        errors.push({
          channelId: channel.channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      gameweekId,
      settledCount: settlements.length,
      failedCount: errors.length,
      totalCollectedFeeStroops,
      totalRefundedStroops,
      settlements,
      errors,
    };
  }
}

export const micropaymentChannelService = new MicropaymentChannelService();
