-- Add retry scheduling fields to failed_payouts for distributed lock-free reprocessing
ALTER TABLE "failed_payouts" ADD COLUMN "retry_scheduled_at" TIMESTAMP(3);
ALTER TABLE "failed_payouts" ADD COLUMN "next_retry_at" TIMESTAMP(3);

-- Create index on next_retry_at for efficient lock-free worker queries
CREATE INDEX "failed_payouts_next_retry_at_idx" ON "failed_payouts"("next_retry_at");

-- Add PAYOUT_RETRY_SCHEDULED to FinancialAuditAction enum
ALTER TYPE "FinancialAuditAction" ADD VALUE 'PAYOUT_RETRY_SCHEDULED' BEFORE 'PAYOUT_RETRY_SUCCEEDED';
