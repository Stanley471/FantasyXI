import { prisma } from "../config/db.js";
import { stellarService, type StellarService } from "../services/financial/stellarService.js";
import { toContractLeagueId } from "../services/financial/contractLeagueId.js";
import {
  FinancialAuditAction,
  financialAuditLog,
  SYSTEM_ACTOR,
  type FinancialAuditRecorder,
} from "../services/audit/financialAuditLog.js";
import { adminAlertNotifier, type AdminAlertSink } from "../services/notifications/adminAlertNotifier.js";

/**
 * Stellar escrow balance reconciliation worker (issue #560).
 *
 * Every 6 hours this job audits each active (UPCOMING / ACTIVE) paid league:
 *
 *   expected = sum(confirmed ENTRY_FEE) - (settled PRIZE_PAYOUT + REFUND amounts)
 *            = (participants * entryFee) - (settledPayouts + refundedAmounts)
 *
 * and compares it, to the stroop, with what the Soroban escrow reports for the
 * league (`total_deposited`). Any difference above zero is a high-priority
 * anomaly: a detailed audit report is logged, the league is flagged for
 * inspection in the append-only financial audit log, and administrators are
 * alerted. The job is strictly read-only; it never moves funds.
 *
 * It also performs a solvency check per escrow token: the contract's actual SAC
 * token balance must be at least the sum of what the audited leagues are
 * expected to hold. (Other leagues share the same contract, so the token balance
 * may legitimately be higher, never lower.)
 *
 * To avoid false alarms on normally progressing leagues:
 *   - leagues with an unfinished (PENDING / SUBMITTED) transaction are skipped for
 *     this run, because the database and chain are legitimately mid-update;
 *   - leagues that are not yet on the contract and expect nothing are treated as
 *     balanced;
 *   - RPC / lookup failures are reported as UNVERIFIED and never raised as drift.
 */

export const STELLAR_RECONCILIATION_JOB_NAME = "stellar-reconciliation";
/** Every 6 hours. */
export const STELLAR_RECONCILIATION_CRON = "0 */6 * * *";

const STROOP_DECIMALS = 7;
const ACTIVE_LEAGUE_STATUSES = ["UPCOMING", "ACTIVE"];
const IN_FLIGHT_STATUSES = new Set(["PENDING", "SUBMITTED"]);

export type EscrowReconciliationStatus = "BALANCED" | "DRIFT" | "UNVERIFIED" | "SKIPPED_IN_FLIGHT";

export interface EscrowLeagueAudit {
  leagueId: string;
  leagueName: string;
  contractLeagueId: string | null;
  status: EscrowReconciliationStatus;
  /** Stroops, as decimal strings so the report is JSON-safe */
  expectedStroops: string;
  onChainStroops: string | null;
  driftStroops: string | null;
  components: {
    confirmedEntryFeesStroops: string;
    settledPayoutsStroops: string;
    refundedStroops: string;
    participants: number;
  };
  reason?: string;
}

export interface TokenSolvencyAudit {
  tokenAddress: string;
  contractBalanceStroops: string;
  requiredStroops: string;
  shortfallStroops: string;
}

export interface EscrowReconciliationReport {
  startedAt: string;
  finishedAt: string;
  leaguesAudited: number;
  balanced: number;
  drifted: number;
  unverified: number;
  skippedInFlight: number;
  flaggedLeagueIds: string[];
  leagues: EscrowLeagueAudit[];
  solvencyShortfalls: TokenSolvencyAudit[];
}

type LeagueRow = {
  id: string;
  name?: string | null;
  transactions?: Array<{ type: string; status: string; amount: unknown }>;
};

export interface EscrowReconciliationDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  stellar?: Pick<StellarService, "getContractLeagueState" | "getContractTokenBalance">;
  audit?: FinancialAuditRecorder;
  alerts?: AdminAlertSink;
  logger?: Pick<Console, "log" | "warn" | "error">;
  now?: () => Date;
}

/** Converts a DB decimal (number, string or Prisma Decimal) to exact stroops. */
export function decimalToStroops(value: unknown): bigint {
  const raw = String(value ?? "0").trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new Error(`Invalid decimal amount: ${raw}`);
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > STROOP_DECIMALS && /[1-9]/.test(fraction.slice(STROOP_DECIMALS))) {
    throw new Error(`Amount ${raw} has more than ${STROOP_DECIMALS} decimal places`);
  }
  const padded = fraction.slice(0, STROOP_DECIMALS).padEnd(STROOP_DECIMALS, "0");
  const stroops = BigInt(whole) * 10n ** BigInt(STROOP_DECIMALS) + BigInt(padded || "0");
  return sign === "-" ? -stroops : stroops;
}

/** Formats stroops as a USDC string for human-readable reports. */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const unit = 10n ** BigInt(STROOP_DECIMALS);
  const frac = (abs % unit).toString().padStart(STROOP_DECIMALS, "0");
  return `${negative ? "-" : ""}${abs / unit}.${frac}`;
}

/** Computes the balance the escrow must hold for a league from confirmed ledger rows. */
export function computeExpectedEscrowBalance(
  transactions: NonNullable<LeagueRow["transactions"]>
): EscrowLeagueAudit["components"] & { expected: bigint } {
  let fees = 0n;
  let payouts = 0n;
  let refunds = 0n;
  let participants = 0;
  for (const tx of transactions) {
    if (tx.status !== "CONFIRMED") continue;
    const amount = decimalToStroops(tx.amount);
    if (tx.type === "ENTRY_FEE") {
      fees += amount;
      participants += 1;
    } else if (tx.type === "PRIZE_PAYOUT") {
      payouts += amount;
    } else if (tx.type === "REFUND") {
      refunds += amount;
    }
  }
  return {
    expected: fees - (payouts + refunds),
    confirmedEntryFeesStroops: fees.toString(),
    settledPayoutsStroops: payouts.toString(),
    refundedStroops: refunds.toString(),
    participants,
  };
}

function safeContractLeagueId(leagueId: string): bigint | null {
  try {
    return toContractLeagueId(leagueId);
  } catch {
    return null;
  }
}

export async function reconcileStellarEscrows(
  deps: EscrowReconciliationDeps = {}
): Promise<EscrowReconciliationReport> {
  const db = deps.db ?? prisma;
  const stellar = deps.stellar ?? stellarService;
  const audit = deps.audit ?? financialAuditLog;
  const alerts = deps.alerts ?? adminAlertNotifier;
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  const leagues: LeagueRow[] = await db.league.findMany({
    where: { status: { in: ACTIVE_LEAGUE_STATUSES }, entryFee: { gt: 0 } },
    select: {
      id: true,
      name: true,
      transactions: { select: { type: true, status: true, amount: true } },
    },
  });

  const results: EscrowLeagueAudit[] = [];
  // Per-token running total of what audited, verified leagues must hold.
  const requiredByToken = new Map<string, bigint>();

  for (const league of leagues) {
    const txs = league.transactions ?? [];
    const base = {
      leagueId: league.id,
      leagueName: league.name ?? "",
    };

    let computed: ReturnType<typeof computeExpectedEscrowBalance>;
    try {
      computed = computeExpectedEscrowBalance(txs);
    } catch (err) {
      results.push({
        ...base,
        contractLeagueId: null,
        status: "UNVERIFIED",
        expectedStroops: "0",
        onChainStroops: null,
        driftStroops: null,
        components: { confirmedEntryFeesStroops: "0", settledPayoutsStroops: "0", refundedStroops: "0", participants: 0 },
        reason: `Invalid ledger amount: ${(err as Error).message}`,
      });
      continue;
    }
    const { expected, ...components } = computed;
    const expectedStroops = expected.toString();

    if (txs.some((tx) => IN_FLIGHT_STATUSES.has(tx.status))) {
      results.push({
        ...base,
        contractLeagueId: null,
        status: "SKIPPED_IN_FLIGHT",
        expectedStroops,
        onChainStroops: null,
        driftStroops: null,
        components,
        reason: "Unfinished transactions in flight; deferred to the next run",
      });
      continue;
    }

    const contractId = safeContractLeagueId(league.id);
    if (contractId === null) {
      results.push({
        ...base,
        contractLeagueId: null,
        status: "UNVERIFIED",
        expectedStroops,
        onChainStroops: null,
        driftStroops: null,
        components,
        reason: "League id cannot be mapped to a contract league id",
      });
      continue;
    }

    let state: Awaited<ReturnType<NonNullable<typeof stellar>["getContractLeagueState"]>>;
    try {
      state = await stellar.getContractLeagueState(contractId);
    } catch (err) {
      results.push({
        ...base,
        contractLeagueId: contractId.toString(),
        status: "UNVERIFIED",
        expectedStroops,
        onChainStroops: null,
        driftStroops: null,
        components,
        reason: `Escrow lookup failed: ${(err as Error)?.message ?? err}`,
      });
      continue;
    }

    // Not deployed on-chain yet and nobody has paid: nothing to compare.
    const onChain = state ? BigInt(state.total_deposited) : 0n;
    const drift = onChain - expected;
    const status: EscrowReconciliationStatus = drift === 0n ? "BALANCED" : "DRIFT";

    results.push({
      ...base,
      contractLeagueId: contractId.toString(),
      status,
      expectedStroops,
      onChainStroops: onChain.toString(),
      driftStroops: drift.toString(),
      components,
      reason:
        status === "DRIFT"
          ? state
            ? `On-chain escrow holds ${formatStroops(onChain)} USDC but the ledger expects ${formatStroops(expected)} USDC`
            : `League is missing on the escrow contract but the ledger expects ${formatStroops(expected)} USDC`
          : undefined,
    });

    if (state?.token_address && status === "BALANCED") {
      requiredByToken.set(state.token_address, (requiredByToken.get(state.token_address) ?? 0n) + expected);
    }
  }

  // Solvency: the contract's real token balance must cover all balanced leagues.
  const solvencyShortfalls: TokenSolvencyAudit[] = [];
  for (const [tokenAddress, required] of requiredByToken) {
    try {
      const balance = await stellar.getContractTokenBalance(tokenAddress);
      if (balance < required) {
        solvencyShortfalls.push({
          tokenAddress,
          contractBalanceStroops: balance.toString(),
          requiredStroops: required.toString(),
          shortfallStroops: (required - balance).toString(),
        });
      }
    } catch (err) {
      logger.warn(
        `[jobs] Stellar reconciliation could not read the token balance for ${tokenAddress}: ${(err as Error)?.message ?? err}`
      );
    }
  }

  const drifted = results.filter((r) => r.status === "DRIFT");
  const flaggedLeagueIds = drifted.map((r) => r.leagueId);
  const finishedAt = now();

  const report: EscrowReconciliationReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    leaguesAudited: results.length,
    balanced: results.filter((r) => r.status === "BALANCED").length,
    drifted: drifted.length,
    unverified: results.filter((r) => r.status === "UNVERIFIED").length,
    skippedInFlight: results.filter((r) => r.status === "SKIPPED_IN_FLIGHT").length,
    flaggedLeagueIds,
    leagues: results,
    solvencyShortfalls,
  };

  for (const entry of drifted) {
    audit.record({
      action: FinancialAuditAction.RECONCILIATION_DISCREPANCY,
      actorId: SYSTEM_ACTOR,
      leagueId: entry.leagueId,
      amount: formatStroops(BigInt(entry.driftStroops ?? "0")),
      asset: "USDC",
      metadata: { source: STELLAR_RECONCILIATION_JOB_NAME, flaggedForInspection: true, ...entry },
    });
  }
  for (const shortfall of solvencyShortfalls) {
    audit.record({
      action: FinancialAuditAction.RECONCILIATION_DISCREPANCY,
      actorId: SYSTEM_ACTOR,
      amount: formatStroops(BigInt(shortfall.shortfallStroops)),
      asset: "USDC",
      metadata: { source: STELLAR_RECONCILIATION_JOB_NAME, kind: "TOKEN_SHORTFALL", ...shortfall },
    });
  }
  if (drifted.length === 0 && solvencyShortfalls.length === 0) {
    audit.record({
      action: FinancialAuditAction.RECONCILIATION_BALANCED,
      actorId: SYSTEM_ACTOR,
      metadata: {
        source: STELLAR_RECONCILIATION_JOB_NAME,
        leaguesAudited: report.leaguesAudited,
        unverified: report.unverified,
        skippedInFlight: report.skippedInFlight,
      },
    });
  }

  if (drifted.length > 0 || solvencyShortfalls.length > 0) {
    logger.error(
      `[jobs] Stellar escrow reconciliation FAILED: ${JSON.stringify(report)}`
    );
    const lines = [
      ...drifted.map((d) => `- league ${d.leagueId} (${d.leagueName}): ${d.reason} [drift ${formatStroops(BigInt(d.driftStroops ?? "0"))} USDC]`),
      ...solvencyShortfalls.map(
        (s) => `- token ${s.tokenAddress}: contract holds ${formatStroops(BigInt(s.contractBalanceStroops))} USDC but needs at least ${formatStroops(BigInt(s.requiredStroops))} USDC`
      ),
    ];
    await alerts.notify({
      title: "Escrow balance anomaly detected",
      severity: "critical",
      text:
        `The Stellar escrow reconciliation found ${drifted.length} league(s) with balance drift` +
        `${solvencyShortfalls.length ? ` and ${solvencyShortfalls.length} token shortfall(s)` : ""}. ` +
        `Affected leagues are flagged for inspection.\n${lines.join("\n")}`,
    });
  } else {
    logger.log(
      `[jobs] Stellar escrow reconciliation OK: ${report.balanced} balanced, ${report.skippedInFlight} deferred, ${report.unverified} unverified`
    );
  }

  return report;
}

/** pg-boss entry point (every 6 hours, see `JOB_DEFINITIONS`). */
export async function runStellarReconciliationJob(): Promise<EscrowReconciliationReport> {
  return reconcileStellarEscrows();
}
