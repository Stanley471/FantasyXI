/**
 * Proof-of-Reserve — cryptographic check that the escrow's on-chain deposit
 * commitments match the PostgreSQL ledger and are fully backed by the token
 * reserve the escrow contract actually holds.
 *
 * Each run:
 *   1. builds a SHA-256 Merkle tree over the ledger's confirmed deposits
 *      (expected state) and another over the contract's `get_deposit`
 *      records (on-chain state); equal roots prove both agree to the stroop,
 *   2. reads the escrow contract's USDC SAC balance (the ledger balance the
 *      network itself holds for the contract) and checks it covers the sum of
 *      on-chain deposit commitments,
 *   3. publishes the roots and totals as the latest public snapshot, records
 *      the run in the financial audit log and pages administrators on any
 *      discrepancy.
 *
 * Leaves are domain-separated from inner nodes (0x00 / 0x01 prefixes) and an
 * odd node is promoted rather than duplicated, so no two different leaf sets
 * share a root.
 */

import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../config/db.js";
import { LeagueStatus, PaymentStatus } from "../../types/index.js";
import { toContractLeagueId } from "./contractLeagueId.js";
import { stellarService } from "./stellarService.js";
import {
  FinancialAuditAction,
  FinancialAuditRecorder,
  financialAuditLog,
  SYSTEM_ACTOR,
} from "../audit/financialAuditLog.js";
import { adminAlertNotifier, AdminAlertSink } from "../notifications/adminAlertNotifier.js";

const STROOPS_PER_UNIT = 10_000_000n;
const EMPTY_ROOT = createHash("sha256").update("FantasyXI/proof-of-reserve/empty").digest("hex");
const READ_CONCURRENCY = 10;

export interface ReserveLeaf {
  contractLeagueId: string;
  address: string;
  amountStroops: bigint;
}

export interface MerkleTree {
  root: string;
  /** levels[0] are the sorted leaf hashes, the last level holds the root */
  levels: Buffer[][];
  leaves: ReserveLeaf[];
}

export interface InclusionProof {
  index: number;
  siblings: Array<{ hash: string; position: "left" | "right" }>;
}

const sortKey = (leaf: ReserveLeaf) => `${leaf.contractLeagueId}:${leaf.address}`;

export function hashReserveLeaf(leaf: ReserveLeaf): Buffer {
  return createHash("sha256")
    .update(Buffer.from([0x00]))
    .update(`${leaf.contractLeagueId}:${leaf.address}:${leaf.amountStroops}`)
    .digest();
}

function hashNode(left: Buffer, right: Buffer): Buffer {
  return createHash("sha256").update(Buffer.from([0x01])).update(left).update(right).digest();
}

/** Builds the deposit Merkle tree; leaves are sorted so the root is order-independent. */
export function buildReserveTree(input: ReserveLeaf[]): MerkleTree {
  const leaves = [...input].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  if (leaves.length === 0) return { root: EMPTY_ROOT, levels: [], leaves };

  const levels: Buffer[][] = [leaves.map(hashReserveLeaf)];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashNode(level[i], level[i + 1]) : level[i]);
    }
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0].toString("hex"), levels, leaves };
}

export function getInclusionProof(tree: MerkleTree, index: number): InclusionProof {
  const siblings: InclusionProof["siblings"] = [];
  let position = index;
  for (const level of tree.levels.slice(0, -1)) {
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    if (sibling < level.length) {
      siblings.push({ hash: level[sibling].toString("hex"), position: position % 2 === 0 ? "right" : "left" });
    }
    position = Math.floor(position / 2);
  }
  return { index, siblings };
}

export function verifyInclusionProof(leaf: ReserveLeaf, proof: InclusionProof, root: string): boolean {
  const computed = proof.siblings.reduce((hash, sibling) => {
    const other = Buffer.from(sibling.hash, "hex");
    return sibling.position === "right" ? hashNode(hash, other) : hashNode(other, hash);
  }, hashReserveLeaf(leaf));
  return computed.toString("hex") === root;
}

export type ReserveDiscrepancy =
  | {
      type: "DEPOSIT_MISMATCH";
      contractLeagueId: string;
      address: string;
      expectedStroops: string;
      onChainStroops: string;
    }
  | { type: "RESERVE_SHORTFALL"; liabilitiesStroops: string; reserveStroops: string };

export interface ProofOfReserveSnapshot {
  runId: string;
  generatedAt: string;
  status: "VERIFIED" | "DISCREPANCY";
  depositCount: number;
  ledgerRoot: string;
  onChainRoot: string;
  liabilitiesStroops: string;
  reserveStroops: string;
  discrepancies: ReserveDiscrepancy[];
  durationMs: number;
}

/** Fields safe to expose on the public endpoint (no addresses). */
export type PublicProofOfReserve = Omit<ProofOfReserveSnapshot, "discrepancies"> & {
  discrepancyCount: number;
};

export interface ReserveContractReader {
  getDepositStrict(contractLeagueId: bigint, address: string): Promise<bigint>;
  getEscrowReserveBalance(): Promise<bigint>;
}

export interface ProofOfReserveOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  contract?: ReserveContractReader;
  alerts?: AdminAlertSink;
  audit?: FinancialAuditRecorder;
}

function toStroops(amount: { toString(): string }): bigint {
  const [whole, fraction = ""] = amount.toString().split(".");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0").slice(0, 7));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ProofOfReserveService {
  private latest: ProofOfReserveSnapshot | null = null;

  constructor(private readonly options: ProofOfReserveOptions = {}) {}

  private get db() {
    return this.options.db ?? prisma;
  }

  private get contract(): ReserveContractReader {
    if (this.options.contract) return this.options.contract;
    const client = stellarService.getSorobanClient();
    if (!client) throw new Error("Soroban contract client is not configured");
    return client;
  }

  /** Confirmed deposits the ledger says the escrow holds for live leagues. */
  private async loadLedgerDeposits(): Promise<ReserveLeaf[]> {
    const members: Array<{ leagueId: string; stellarAddress: string; league: { entryFee: { toString(): string } } }> =
      await this.db.leagueMember.findMany({
        where: {
          paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
          stellarAddress: { not: null },
          league: { status: { in: [LeagueStatus.UPCOMING, LeagueStatus.ACTIVE] }, entryFee: { gt: 0 } },
        },
        select: { leagueId: true, stellarAddress: true, league: { select: { entryFee: true } } },
      });
    return members.map((member) => ({
      contractLeagueId: toContractLeagueId(member.leagueId).toString(),
      address: member.stellarAddress,
      amountStroops: toStroops(member.league.entryFee),
    }));
  }

  /** Computes the Merkle roots and discrepancies for a given pair of states. */
  public static compare(
    ledger: ReserveLeaf[],
    onChain: ReserveLeaf[],
    reserveStroops: bigint
  ): Omit<ProofOfReserveSnapshot, "runId" | "generatedAt" | "durationMs"> {
    const ledgerTree = buildReserveTree(ledger);
    const chainTree = buildReserveTree(onChain);
    const discrepancies: ReserveDiscrepancy[] = [];

    if (ledgerTree.root !== chainTree.root) {
      const chainByKey = new Map(chainTree.leaves.map((leaf) => [sortKey(leaf), leaf.amountStroops]));
      for (const leaf of ledgerTree.leaves) {
        const actual = chainByKey.get(sortKey(leaf)) ?? 0n;
        if (actual !== leaf.amountStroops) {
          discrepancies.push({
            type: "DEPOSIT_MISMATCH",
            contractLeagueId: leaf.contractLeagueId,
            address: leaf.address,
            expectedStroops: leaf.amountStroops.toString(),
            onChainStroops: actual.toString(),
          });
        }
      }
    }

    const liabilities = chainTree.leaves.reduce((sum, leaf) => sum + leaf.amountStroops, 0n);
    if (reserveStroops < liabilities) {
      discrepancies.push({
        type: "RESERVE_SHORTFALL",
        liabilitiesStroops: liabilities.toString(),
        reserveStroops: reserveStroops.toString(),
      });
    }

    return {
      status: discrepancies.length === 0 ? "VERIFIED" : "DISCREPANCY",
      depositCount: ledgerTree.leaves.length,
      ledgerRoot: ledgerTree.root,
      onChainRoot: chainTree.root,
      liabilitiesStroops: liabilities.toString(),
      reserveStroops: reserveStroops.toString(),
      discrepancies,
    };
  }

  /** Runs one verification, publishes the snapshot and alerts on mismatch. */
  public async generateSnapshot(trigger: "scheduled" | "manual" = "scheduled"): Promise<ProofOfReserveSnapshot> {
    const started = Date.now();
    const contract = this.contract;
    const ledger = await this.loadLedgerDeposits();
    const onChain = await mapWithConcurrency(ledger, READ_CONCURRENCY, async (leaf) => ({
      ...leaf,
      amountStroops: await contract.getDepositStrict(BigInt(leaf.contractLeagueId), leaf.address),
    }));
    const reserve = await contract.getEscrowReserveBalance();

    const snapshot: ProofOfReserveSnapshot = {
      runId: randomUUID(),
      generatedAt: new Date().toISOString(),
      ...ProofOfReserveService.compare(ledger, onChain, reserve),
      durationMs: Date.now() - started,
    };
    this.latest = snapshot;

    (this.options.audit ?? financialAuditLog).record({
      action:
        snapshot.status === "VERIFIED"
          ? FinancialAuditAction.RECONCILIATION_BALANCED
          : FinancialAuditAction.RECONCILIATION_DISCREPANCY,
      actorId: SYSTEM_ACTOR,
      metadata: {
        source: "proof-of-reserve",
        trigger,
        runId: snapshot.runId,
        ledgerRoot: snapshot.ledgerRoot,
        onChainRoot: snapshot.onChainRoot,
        depositCount: snapshot.depositCount,
        liabilitiesStroops: snapshot.liabilitiesStroops,
        reserveStroops: snapshot.reserveStroops,
        discrepancies: snapshot.discrepancies.slice(0, 50),
      },
    });

    if (snapshot.status === "DISCREPANCY") {
      await (this.options.alerts ?? adminAlertNotifier).notify({
        title: "Proof-of-reserve discrepancy detected",
        severity: "critical",
        text: [
          `Run ${snapshot.runId}: ${snapshot.discrepancies.length} discrepanc${snapshot.discrepancies.length === 1 ? "y" : "ies"}.`,
          `Ledger root ${snapshot.ledgerRoot} vs on-chain root ${snapshot.onChainRoot}.`,
          `Liabilities ${snapshot.liabilitiesStroops} stroops, reserve ${snapshot.reserveStroops} stroops.`,
          ...snapshot.discrepancies.slice(0, 10).map((d) =>
            d.type === "DEPOSIT_MISMATCH"
              ? `- league ${d.contractLeagueId} ${d.address}: ledger ${d.expectedStroops} vs chain ${d.onChainStroops}`
              : `- reserve shortfall: ${d.reserveStroops} < ${d.liabilitiesStroops}`
          ),
        ].join("\n"),
      });
    }
    return snapshot;
  }

  public getLatestSnapshot(): ProofOfReserveSnapshot | null {
    return this.latest;
  }

  public getPublicSnapshot(): PublicProofOfReserve | null {
    if (!this.latest) return null;
    const { discrepancies, ...rest } = this.latest;
    return { ...rest, discrepancyCount: discrepancies.length };
  }
}

export const proofOfReserveService = new ProofOfReserveService();
