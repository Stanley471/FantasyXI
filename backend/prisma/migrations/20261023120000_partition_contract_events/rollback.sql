-- Rollback while the monthly partitions are still attached. Restore the legacy
-- unpartitioned table atomically; Prisma can then use its original id primary key.
CREATE TABLE "contract_events_unpartitioned" (LIKE "contract_events" INCLUDING DEFAULTS INCLUDING GENERATED);
INSERT INTO "contract_events_unpartitioned"
SELECT id, contract_id, event_type, league_id, tx_hash, ledger_seq, payload, created_at
FROM "contract_events";
ALTER TABLE "contract_events_unpartitioned" ADD PRIMARY KEY (id);
CREATE INDEX "contract_events_event_type_idx" ON "contract_events_unpartitioned" (event_type);
CREATE INDEX "contract_events_league_id_idx" ON "contract_events_unpartitioned" (league_id);
CREATE INDEX "contract_events_tx_hash_idx" ON "contract_events_unpartitioned" (tx_hash);
CREATE INDEX "contract_events_ledger_seq_idx" ON "contract_events_unpartitioned" (ledger_seq);
BEGIN;
LOCK TABLE "contract_events" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "contract_events" RENAME TO "contract_events_partitioned_rollback";
ALTER TABLE "contract_events_unpartitioned" RENAME TO "contract_events";
COMMIT;
DROP TABLE "contract_events_partitioned_rollback" CASCADE;
