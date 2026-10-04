import { prisma } from "../config/db.js";
import { LeagueStatus, PaymentStatus } from "../types/index.js";
import { leagueService } from "../services/league/leagueService.js";
import { financialService } from "../services/financial/financialService.js";

/**
 * League Refund Job.
 *
 * 1. Cancels UPCOMING leagues that missed minMembers by their start gameweek kickoff.
 * 2. Dispatches batched on-chain refunds for every cancelled league with paid members
 *    (covers both automatic and creator/admin cancellations).
 * 3. Verifies the escrow holds nothing for fully refunded leagues.
 *
 * Failed batches are isolated in the payout dead-letter queue instead of failing the
 * job: recoverable ones are retried by the next run, the rest wait for an admin via
 * /api/v1/admin/payouts/dead-letter. The job only throws on unexpected errors.
 */
export async function processLeagueRefunds(): Promise<void> {
  const cancelled = await leagueService.cancelUnderfilledLeagues();
  if (cancelled.length > 0) {
    console.log(`[jobs] Cancelled underfilled leagues: ${cancelled.join(", ")}`);
  }

  const leagues = await prisma.league.findMany({
    where: {
      status: LeagueStatus.CANCELLED,
      members: {
        some: {
          paymentStatus: {
            in: [PaymentStatus.REFUND_PENDING, PaymentStatus.PAYMENT_CONFIRMED],
          },
        },
      },
    },
    select: { id: true },
  });

  for (const { id } of leagues) {
    const report = await financialService.processLeagueRefunds(id);
    console.log(
      `[jobs] League ${id}: refunded ${report.refundedMemberIds.length} member(s) in ${report.batches} batch(es), ` +
        `${report.failedBatches.length} failed, ${report.skippedMemberIds.length} without wallet, ` +
        `${report.isolatedMemberIds.length} isolated in DLQ, ${report.autoRetried.length} auto-retried`
    );

    if (report.deadLetteredIds.length > 0) {
      console.warn(
        `[jobs] League ${id}: ${report.deadLetteredIds.length} payout(s) dead-lettered: ${report.deadLetteredIds.join(", ")}`
      );
    }

    const outstanding =
      report.deadLetteredIds.length > 0 ||
      report.isolatedMemberIds.length > 0 ||
      report.autoRetried.some((r) => !r.success);
    if (outstanding) {
      continue;
    }

    const reconciliation = await financialService.verifyRefundReconciliation(id);
    console.log(
      `[jobs] League ${id} escrow reconciliation: remaining=${reconciliation.remainingEscrowStroops} stroops, ` +
        `fullyRefunded=${reconciliation.isFullyRefunded}`
    );
  }
}
