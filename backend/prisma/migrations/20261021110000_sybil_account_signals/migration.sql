-- CreateEnum
CREATE TYPE "AccountSignalType" AS ENUM ('DEVICE', 'IP_SUBNET');

-- CreateTable
CREATE TABLE "account_signals" (
    "type" "AccountSignalType" NOT NULL,
    "value" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_signals_pkey" PRIMARY KEY ("type","value","user_id")
);

-- CreateTable
CREATE TABLE "stellar_account_funders" (
    "address" TEXT NOT NULL,
    "funder" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stellar_account_funders_pkey" PRIMARY KEY ("address")
);

-- CreateIndex
CREATE INDEX "account_signals_user_id_idx" ON "account_signals"("user_id");

-- CreateIndex
CREATE INDEX "stellar_account_funders_funder_idx" ON "stellar_account_funders"("funder");

-- AddForeignKey
ALTER TABLE "account_signals" ADD CONSTRAINT "account_signals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
