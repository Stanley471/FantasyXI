-- AlterTable
ALTER TABLE "league_members"
ADD COLUMN "payout_hold_at" TIMESTAMP(3),
ADD COLUMN "payout_hold_reason" TEXT,
ADD COLUMN "payout_risk_score" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "passkey_recovery_keys" (
    "user_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMP(3),
    CONSTRAINT "passkey_recovery_keys_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "passkey_recovery_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "passkey_recovery_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_security_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_security_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "passkey_recovery_challenges_user_id_expires_at_idx"
ON "passkey_recovery_challenges"("user_id", "expires_at");

CREATE INDEX "account_security_events_user_id_created_at_idx"
ON "account_security_events"("user_id", "created_at");

CREATE INDEX "account_security_events_type_created_at_idx"
ON "account_security_events"("type", "created_at");

ALTER TABLE "passkey_recovery_keys" ADD CONSTRAINT "passkey_recovery_keys_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "passkey_recovery_challenges" ADD CONSTRAINT "passkey_recovery_challenges_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_security_events" ADD CONSTRAINT "account_security_events_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
