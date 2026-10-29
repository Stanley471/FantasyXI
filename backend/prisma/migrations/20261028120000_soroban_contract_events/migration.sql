-- Decoded Soroban escrow contract events (issue #230).
CREATE TABLE "soroban_contract_events" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "league_id" TEXT,
    "ledger_seq" INTEGER NOT NULL,
    "ledger_closed_at" TIMESTAMP(3) NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "in_successful_contract_call" BOOLEAN NOT NULL DEFAULT true,
    "topics" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "soroban_contract_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "soroban_contract_events_ledger_seq_idx" ON "soroban_contract_events"("ledger_seq");
CREATE INDEX "soroban_contract_events_category_ledger_seq_idx" ON "soroban_contract_events"("category", "ledger_seq");
CREATE INDEX "soroban_contract_events_league_id_ledger_seq_idx" ON "soroban_contract_events"("league_id", "ledger_seq");
CREATE INDEX "soroban_contract_events_tx_hash_idx" ON "soroban_contract_events"("tx_hash");
