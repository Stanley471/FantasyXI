import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { stellarConfig } from "../../config/stellar.js";
import { TransactionStatus, TransactionType } from "../../types/index.js";
import { INDEXER_CURSOR_ID } from "../../workers/eventIndexer.js";
import { toContractLeagueId } from "./contractLeagueId.js";
import { StellarService, stellarService } from "./stellarService.js";

const STROOPS_PER_USDC = 10_000_000n;
const MAX_INDEXER_LAG_LEDGERS = 10;
const AUDITABLE_TRANSACTION_TYPES = [
  TransactionType.ENTRY_FEE,
  TransactionType.PLATFORM_FEE,
  TransactionType.PRIZE_PAYOUT,
  TransactionType.REFUND,
];

type AuditSeverity = "HIGH" | "MEDIUM" | "LOW";
type TransactionAmount = { toString(): string } | string | number;

export interface LedgerAuditFindingInput {
  severity: AuditSeverity;
  category: string;
  message: string;
  leagueId?: string;
  txHash?: string;
  ledgerSeq?: number;
  expectedStroops?: string;
  observedStroops?: string;
  discrepancyStroops?: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface LedgerAuditTransactionInput {
  type: string;
  amount: TransactionAmount;
  status: string;
  leagueId?: string | null;
  stellarTxHash?: string | null;
  ledgerSeq?: number | null;
}

export interface LedgerAuditEventInput {
  eventType: string;
  leagueId?: string | null;
  txHash: string;
  ledgerSeq: number;
  payload: unknown;
}

export interface ActiveLeagueAuditSnapshot {
  leagueId: string;
  stateFound: boolean;
  expectedDepositStroops: string;
  observedDepositStroops: string;
  databaseParticipantCount: number;
  chainParticipantCount: number | null;
}

export interface BuildLedgerAuditFindingsInput {
  expectedBalanceStroops: bigint;
  observedBalanceStroops: bigint;
  thresholdStroops: bigint;
  latestSorobanLedger: number;
  indexedThroughLedger: number;
  transactions: LedgerAuditTransactionInput[];
  events: LedgerAuditEventInput[];
  leagues: ActiveLeagueAuditSnapshot[];
  coverageComplete: boolean;
}

function decimalToStroops(amount: TransactionAmount): bigint {
  const value = String(amount);
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid non-negative USDC amount in ledger: ${value}`);
  }
  const fraction = (match[2] ?? "").padEnd(7, "0");
  return BigInt(match[1]) * STROOPS_PER_USDC + BigInt(fraction || "0");
}

function valueToStroops(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Invalid stroops value in indexed escrow event: ${String(value)}`);
}

function eventValue(event: LedgerAuditEventInput): unknown {
  if (!event.payload || typeof event.payload !== "object" || !("value" in event.payload)) {
    return undefined;
  }
  return (event.payload as { value?: unknown }).value;
}

function addFinding(
  findings: LedgerAuditFindingInput[],
  finding: LedgerAuditFindingInput
): void {
  findings.push(finding);
}

export function calculateExpectedEscrowBalance(
  transactions: LedgerAuditTransactionInput[]
): bigint {
  let balance = 0n;
  for (const transaction of transactions) {
    if (transaction.status !== TransactionStatus.CONFIRMED) continue;
    if (!AUDITABLE_TRANSACTION_TYPES.includes(transaction.type as TransactionType)) continue;
    const amount = decimalToStroops(transaction.amount);
    switch (transaction.type) {
      case TransactionType.ENTRY_FEE:
        balance += amount;
        break;
      case TransactionType.PLATFORM_FEE:
      case TransactionType.PRIZE_PAYOUT:
      case TransactionType.REFUND:
        balance -= amount;
        break;
    }
  }
  return balance;
}

export function buildLedgerAuditFindings(
  input: BuildLedgerAuditFindingsInput
): LedgerAuditFindingInput[] {
  const findings: LedgerAuditFindingInput[] = [];
  const balanceDifference = input.observedBalanceStroops - input.expectedBalanceStroops;
  if (abs(balanceDifference) > input.thresholdStroops && input.coverageComplete) {
    addFinding(findings, {
      severity: "HIGH",
      category: "ESCROW_BALANCE_MISMATCH",
      message: "Soroban escrow balance differs from confirmed database ledger activity.",
      expectedStroops: input.expectedBalanceStroops.toString(),
      observedStroops: input.observedBalanceStroops.toString(),
      discrepancyStroops: balanceDifference.toString(),
    });
  }

  if (!input.coverageComplete) {
    addFinding(findings, {
      severity: "LOW",
      category: "INDEXER_LAG",
      message: "Balance reconciliation is deferred because the event indexer is not current.",
      details: {
        indexedThroughLedger: input.indexedThroughLedger,
        latestSorobanLedger: input.latestSorobanLedger,
      },
    });
  } else {
    for (const league of input.leagues) {
      if (!league.stateFound) {
        addFinding(findings, {
          severity: "HIGH",
          category: "MISSING_ONCHAIN_LEAGUE",
          message: "An active database league has no corresponding Soroban escrow state.",
          leagueId: league.leagueId,
        });
        continue;
      }

      const expected = BigInt(league.expectedDepositStroops);
      const observed = BigInt(league.observedDepositStroops);
      if (abs(observed - expected) > input.thresholdStroops) {
        addFinding(findings, {
          severity: "HIGH",
          category: "LEAGUE_DEPOSIT_MISMATCH",
          message: "Active league member deposits differ between the database and escrow contract.",
          leagueId: league.leagueId,
          expectedStroops: expected.toString(),
          observedStroops: observed.toString(),
          discrepancyStroops: (observed - expected).toString(),
        });
      }

      if (
        league.chainParticipantCount !== null &&
        league.chainParticipantCount !== league.databaseParticipantCount
      ) {
        addFinding(findings, {
          severity: "HIGH",
          category: "LEAGUE_PARTICIPANT_COUNT_MISMATCH",
          message: "The escrow participant count differs from confirmed database entry records.",
          leagueId: league.leagueId,
          expectedStroops: String(league.databaseParticipantCount),
          observedStroops: String(league.chainParticipantCount),
        });
      }
    }
  }

  const transactionsByHash = new Map<string, LedgerAuditTransactionInput[]>();
  for (const transaction of input.transactions) {
    if (!transaction.stellarTxHash) continue;
    const current = transactionsByHash.get(transaction.stellarTxHash) ?? [];
    current.push(transaction);
    transactionsByHash.set(transaction.stellarTxHash, current);
  }

  for (const event of input.events) {
    const value = eventValue(event);
    if (event.eventType === "deposit" && Array.isArray(value)) {
      const tx = transactionsByHash.get(event.txHash)?.find(
        (candidate) => candidate.type === TransactionType.ENTRY_FEE
      );
      const expected = valueToStroops(value[1]);
      if (!tx || tx.status !== TransactionStatus.CONFIRMED) {
        addFinding(findings, {
          severity: "HIGH",
          category: "MISSING_DEPOSIT_RECORD",
          message: "An indexed on-chain deposit has no confirmed database entry-fee record.",
          leagueId: event.leagueId ?? undefined,
          txHash: event.txHash,
          ledgerSeq: event.ledgerSeq,
          expectedStroops: expected.toString(),
        });
      } else {
        const observed = decimalToStroops(tx.amount);
        if (observed !== expected) {
          addFinding(findings, {
            severity: "HIGH",
            category: "DEPOSIT_AMOUNT_MISMATCH",
            message: "The database entry-fee amount differs from the indexed on-chain deposit.",
            leagueId: event.leagueId ?? undefined,
            txHash: event.txHash,
            ledgerSeq: event.ledgerSeq,
            expectedStroops: expected.toString(),
            observedStroops: observed.toString(),
            discrepancyStroops: (observed - expected).toString(),
          });
        }
      }
    } else if (event.eventType === "claimed" && Array.isArray(value)) {
      const winner = String(value[0]);
      const hash = `${event.txHash}-${winner}`;
      const tx = transactionsByHash.get(hash)?.find(
        (candidate) => candidate.type === TransactionType.PRIZE_PAYOUT
      );
      const expected = valueToStroops(value[1]);
      if (!tx || tx.status !== TransactionStatus.CONFIRMED) {
        addFinding(findings, {
          severity: "HIGH",
          category: "UN_CREDITED_PAYOUT",
          message: "An on-chain prize claim has no confirmed database payout record.",
          leagueId: event.leagueId ?? undefined,
          txHash: event.txHash,
          ledgerSeq: event.ledgerSeq,
          expectedStroops: expected.toString(),
          details: { winner },
        });
      } else {
        const observed = decimalToStroops(tx.amount);
        if (observed !== expected) {
          addFinding(findings, {
            severity: "HIGH",
            category: "PAYOUT_AMOUNT_MISMATCH",
            message: "The database payout amount differs from the indexed on-chain claim.",
            leagueId: event.leagueId ?? undefined,
            txHash: event.txHash,
            ledgerSeq: event.ledgerSeq,
            expectedStroops: expected.toString(),
            observedStroops: observed.toString(),
            discrepancyStroops: (observed - expected).toString(),
            details: { winner },
          });
        }
      }
    } else if (event.eventType === "settle" && Array.isArray(value)) {
      const expected = valueToStroops(value[1]);
      if (expected <= 0n) continue;
      const hash = `${event.txHash}-fee`;
      const tx = transactionsByHash.get(hash)?.find(
        (candidate) => candidate.type === TransactionType.PLATFORM_FEE
      );
      if (!tx || tx.status !== TransactionStatus.CONFIRMED) {
        addFinding(findings, {
          severity: "HIGH",
          category: "MISSING_PLATFORM_FEE_RECORD",
          message: "An on-chain settlement fee has no confirmed database record.",
          leagueId: event.leagueId ?? undefined,
          txHash: event.txHash,
          ledgerSeq: event.ledgerSeq,
          expectedStroops: expected.toString(),
        });
      } else {
        const observed = decimalToStroops(tx.amount);
        if (observed !== expected) {
          addFinding(findings, {
            severity: "HIGH",
            category: "PLATFORM_FEE_MISMATCH",
            message: "The database platform fee differs from the indexed settlement event.",
            leagueId: event.leagueId ?? undefined,
            txHash: event.txHash,
            ledgerSeq: event.ledgerSeq,
            expectedStroops: expected.toString(),
            observedStroops: observed.toString(),
            discrepancyStroops: (observed - expected).toString(),
          });
        }
      }
    } else if (event.eventType === "refund" && value !== undefined) {
      const expectedCount = Number(value);
      const refunds = input.transactions.filter(
        (transaction) =>
          transaction.type === TransactionType.REFUND &&
          transaction.stellarTxHash?.startsWith(`${event.txHash}-`) &&
          transaction.ledgerSeq === event.ledgerSeq &&
          transaction.status === TransactionStatus.CONFIRMED
      );
      if (Number.isSafeInteger(expectedCount) && refunds.length !== expectedCount) {
        addFinding(findings, {
          severity: "HIGH",
          category: "REFUND_RECORD_COUNT_MISMATCH",
          message: "The confirmed database refund count differs from the on-chain refund event.",
          leagueId: event.leagueId ?? undefined,
          txHash: event.txHash,
          ledgerSeq: event.ledgerSeq,
          expectedStroops: String(expectedCount),
          observedStroops: String(refunds.length),
          discrepancyStroops: String(refunds.length - expectedCount),
        });
      }
    }
  }

  return findings.sort((left, right) =>
    `${left.category}:${left.txHash ?? ""}:${left.leagueId ?? ""}`.localeCompare(
      `${right.category}:${right.txHash ?? ""}:${right.leagueId ?? ""}`
    )
  );
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function configuredThreshold(): bigint {
  const configured = process.env.LEDGER_AUDIT_THRESHOLD_STROOPS;
  if (configured === undefined) return 100_000n;
  if (!/^\d+$/.test(configured)) {
    throw new Error("LEDGER_AUDIT_THRESHOLD_STROOPS must be a non-negative integer");
  }
  return BigInt(configured);
}

function eventHashPayload(
  run: {
    id: string;
    horizonLedger: number;
    sorobanLedger: number;
    indexedThroughLedger: number;
    expectedBalanceStroops: string;
    observedBalanceStroops: string;
    discrepancyStroops: string;
    thresholdStroops: string;
    findingCount: number;
    isBalanced: boolean;
    previousHash: string | null;
    createdAt: Date;
  },
  findings: LedgerAuditFindingInput[]
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...run,
        createdAt: run.createdAt.toISOString(),
        findings,
      })
    )
    .digest("hex");
}

export interface LedgerAuditServiceOptions {
  db?: PrismaClient;
  stellar?: StellarService;
}

export class LedgerAuditService {
  private readonly db: PrismaClient;
  private readonly stellar: StellarService;

  constructor(options: LedgerAuditServiceOptions = {}) {
    this.db = options.db ?? prisma;
    this.stellar = options.stellar ?? stellarService;
  }

  public async runAudit() {
    const [leagues, transactions, events, cursor, rpcRange, horizonLedger, observedBalance] =
      await Promise.all([
        this.db.league.findMany({
          where: { status: { in: ["UPCOMING", "ACTIVE"] } },
          select: {
            id: true,
            members: {
              select: {
                stellarAddress: true,
                user: { select: { wallet: { select: { stellarAddress: true } } } },
              },
            },
          },
        }),
        this.db.transaction.findMany({
          where: {
            leagueId: { not: null },
            type: { in: AUDITABLE_TRANSACTION_TYPES },
          },
          select: {
            type: true,
            amount: true,
            status: true,
            leagueId: true,
            stellarTxHash: true,
            ledgerSeq: true,
          },
        }),
        this.db.contractEvent.findMany({
          where: { eventType: { in: ["deposit", "settle", "refund", "claimed"] } },
          orderBy: [{ ledgerSeq: "asc" }, { txHash: "asc" }],
          select: { eventType: true, leagueId: true, txHash: true, ledgerSeq: true, payload: true },
        }),
        this.db.indexerCursor.findUnique({ where: { id: INDEXER_CURSOR_ID } }),
        this.stellar.getRpcLedgerRange(),
        this.stellar.getHorizonLatestLedger(),
        this.stellar.getContractTokenBalanceForAudit(stellarConfig.escrowContractId),
      ]);

    const auditTransactions: LedgerAuditTransactionInput[] = transactions.map((transaction) => ({
      ...transaction,
      amount: transaction.amount.toString(),
    }));
    const expectedBalance = calculateExpectedEscrowBalance(auditTransactions);
    const indexedThroughLedger = cursor?.lastLedger ?? 0;
    const coverageComplete =
      indexedThroughLedger > 0 &&
      rpcRange.latestLedger - indexedThroughLedger <= MAX_INDEXER_LAG_LEDGERS;
    const leagueSnapshots = await Promise.all(
      leagues.map(async (league): Promise<ActiveLeagueAuditSnapshot> => {
        const contractLeagueId = toContractLeagueId(league.id);
        const state = await this.stellar.getContractLeagueStateForAudit(contractLeagueId);
        if (!state) {
          return {
            leagueId: league.id,
            stateFound: false,
            expectedDepositStroops: "0",
            observedDepositStroops: "0",
            databaseParticipantCount: 0,
            chainParticipantCount: null,
          };
        }

        const addresses = league.members
          .map((member) => member.stellarAddress ?? member.user.wallet?.stellarAddress)
          .filter((address): address is string => Boolean(address));
        const deposits = await Promise.all(
          addresses.map((address) =>
            this.stellar.getContractDepositForAudit(contractLeagueId, address)
          )
        );
        const expectedTransactions = auditTransactions.filter(
          (transaction) =>
            transaction.leagueId === league.id &&
            transaction.type === TransactionType.ENTRY_FEE &&
            transaction.status === TransactionStatus.CONFIRMED
        );
        return {
          leagueId: league.id,
          stateFound: true,
          expectedDepositStroops: expectedTransactions
            .reduce((total, transaction) => total + decimalToStroops(transaction.amount), 0n)
            .toString(),
          observedDepositStroops: deposits.reduce((total, amount) => total + amount, 0n).toString(),
          databaseParticipantCount: expectedTransactions.length,
          chainParticipantCount: state.participant_count,
        };
      })
    );

    const findings = buildLedgerAuditFindings({
      expectedBalanceStroops: expectedBalance,
      observedBalanceStroops: observedBalance,
      thresholdStroops: configuredThreshold(),
      latestSorobanLedger: rpcRange.latestLedger,
      indexedThroughLedger,
      transactions: auditTransactions,
      events: events as LedgerAuditEventInput[],
      leagues: leagueSnapshots,
      coverageComplete,
    });
    const thresholdStroops = configuredThreshold();
    const previous = await this.db.ledgerAuditRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: { reportHash: true },
    });
    const createdAt = new Date();
    const run = {
      id: randomUUID(),
      horizonLedger,
      sorobanLedger: rpcRange.latestLedger,
      indexedThroughLedger,
      expectedBalanceStroops: expectedBalance.toString(),
      observedBalanceStroops: observedBalance.toString(),
      discrepancyStroops: (observedBalance - expectedBalance).toString(),
      thresholdStroops: thresholdStroops.toString(),
      findingCount: findings.length,
      isBalanced:
        coverageComplete &&
        abs(observedBalance - expectedBalance) <= thresholdStroops &&
        findings.every((finding) => finding.severity === "LOW"),
      previousHash: previous?.reportHash ?? null,
      createdAt,
    };
    const reportHash = eventHashPayload(run, findings);

    await this.db.$transaction(async (transaction) => {
      await transaction.ledgerAuditRun.create({ data: { ...run, reportHash } });
      if (findings.length) {
        await transaction.ledgerAuditFinding.createMany({
          data: findings.map((finding) => ({ ...finding, auditRunId: run.id })),
        });
      }
    });

    const highFindings = findings.filter((finding) => finding.severity === "HIGH");
    if (highFindings.length) {
      console.error(
        `[ledger-audit][HIGH] ${highFindings.length} discrepancy finding(s) in report ${run.id}`,
        highFindings.map(({ category, txHash, ledgerSeq, leagueId }) => ({
          category,
          txHash,
          ledgerSeq,
          leagueId,
        }))
      );
    }

    return { ...run, reportHash, findings };
  }
}

export const ledgerAuditService = new LedgerAuditService();
