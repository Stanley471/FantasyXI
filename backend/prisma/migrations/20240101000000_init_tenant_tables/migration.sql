-- CreateEnum
CREATE TYPE "Position" AS ENUM ('GKP', 'DEF', 'MID', 'FWD');
CREATE TYPE "LeagueStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'CANCELLED', 'REFUNDED');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAYMENT_INITIATED', 'PAYMENT_SUBMITTED', 'PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'REFUND_PENDING', 'REFUNDED');
CREATE TYPE "ScoringType" AS ENUM ('CLASSIC', 'HEAD_TO_HEAD');
CREATE TYPE "ChipType" AS ENUM ('TRIPLE_CAPTAIN', 'BENCH_BOOST', 'FREE_HIT', 'WILDCARD');
CREATE TYPE "UserRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN');
CREATE TYPE "TransactionType" AS ENUM ('ENTRY_FEE', 'PLATFORM_FEE', 'PRIZE_PAYOUT', 'REFUND');
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');
CREATE TYPE "LeagueTierMovement" AS ENUM ('STAY', 'PROMOTE', 'RELEGATE');
CREATE TYPE "FinancialAuditAction" AS ENUM ('DEPOSIT_SUBMITTED', 'DEPOSIT_CONFIRMED', 'DEPOSIT_FAILED', 'WITHDRAWAL', 'REFUND', 'FEE_EXTRACTION', 'PAYOUT_DEAD_LETTERED', 'PAYOUT_RETRY_SUCCEEDED', 'PAYOUT_RETRY_FAILED', 'PAYOUT_DISCARDED', 'RECONCILIATION_BALANCED', 'RECONCILIATION_DISCREPANCY');
CREATE TYPE "FailedPayoutStatus" AS ENUM ('PENDING', 'RETRYING', 'RESOLVED', 'DISCARDED');
CREATE TYPE "CoordinatedTransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'DROPPED');

-- Note: This is a minimal migration template. Full table creation is handled by Prisma's 
-- automatic migration generation. This file serves as a reference for tenant schema initialization.
-- 
-- For actual tenant schema setup, run:
--   npm run db:migrate:tenants
--
-- Which will apply all pending Prisma migrations to each tenant schema.
