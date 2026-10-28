-- Nullable additive column: existing coordinator records remain valid.
ALTER TABLE "coordinated_transactions" ADD COLUMN "settlement_key" TEXT;
CREATE UNIQUE INDEX "coordinated_transactions_settlement_key_key" ON "coordinated_transactions"("settlement_key");
