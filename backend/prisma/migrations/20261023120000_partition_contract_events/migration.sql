-- Online cutover for the append-only event ledger. The mirror trigger keeps writes
-- arriving during the historical copy visible in both tables; the ACCESS EXCLUSIVE
-- lock is held only for the final delta copy and metadata swap.
CREATE TABLE "contract_events_partitioned" (
  "id" TEXT NOT NULL,
  "contract_id" TEXT,
  "event_type" TEXT NOT NULL,
  "league_id" TEXT,
  "tx_hash" TEXT NOT NULL,
  "ledger_seq" INTEGER NOT NULL,
  "payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");

CREATE TABLE "contract_events_default" PARTITION OF "contract_events_partitioned" DEFAULT;

DO $$
DECLARE
  first_month DATE;
  last_month DATE;
  month_start DATE;
BEGIN
  SELECT date_trunc('month', min(created_at))::date,
         date_trunc('month', max(created_at))::date
    INTO first_month, last_month FROM contract_events;
  IF first_month IS NULL THEN
    first_month := date_trunc('month', CURRENT_DATE)::date;
    last_month := first_month;
  END IF;
  last_month := GREATEST(last_month, date_trunc('month', CURRENT_DATE + INTERVAL '14 days')::date);
  month_start := first_month;
  WHILE month_start <= last_month LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF contract_events_partitioned FOR VALUES FROM (%L) TO (%L)',
      'contract_events_' || to_char(month_start, 'YYYY_MM'),
      month_start,
      (month_start + INTERVAL '1 month')::date
    );
    month_start := (month_start + INTERVAL '1 month')::date;
  END LOOP;
END $$;

CREATE INDEX "contract_events_partitioned_event_type_created_at_idx" ON "contract_events_partitioned" ("event_type", "created_at");
CREATE INDEX "contract_events_partitioned_league_id_idx" ON "contract_events_partitioned" ("league_id");
CREATE INDEX "contract_events_partitioned_tx_hash_created_at_idx" ON "contract_events_partitioned" ("tx_hash", "created_at");
CREATE INDEX "contract_events_partitioned_ledger_seq_idx" ON "contract_events_partitioned" ("ledger_seq");

CREATE FUNCTION mirror_contract_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO contract_events_partitioned (id, contract_id, event_type, league_id, tx_hash, ledger_seq, payload, created_at)
  VALUES (NEW.id, NEW.contract_id, NEW.event_type, NEW.league_id, NEW.tx_hash, NEW.ledger_seq, NEW.payload, NEW.created_at)
  ON CONFLICT (id, created_at) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_events_partition_mirror
  AFTER INSERT ON contract_events FOR EACH ROW EXECUTE FUNCTION mirror_contract_event_insert();

INSERT INTO contract_events_partitioned (id, contract_id, event_type, league_id, tx_hash, ledger_seq, payload, created_at)
SELECT id, contract_id, event_type, league_id, tx_hash, ledger_seq, payload, created_at FROM contract_events
ON CONFLICT (id, created_at) DO NOTHING;

BEGIN;
LOCK TABLE contract_events IN ACCESS EXCLUSIVE MODE;
INSERT INTO contract_events_partitioned (id, contract_id, event_type, league_id, tx_hash, ledger_seq, payload, created_at)
SELECT id, contract_id, event_type, league_id, tx_hash, ledger_seq, payload, created_at FROM contract_events
ON CONFLICT (id, created_at) DO NOTHING;
DROP TRIGGER contract_events_partition_mirror ON contract_events;
ALTER TABLE contract_events RENAME TO contract_events_pre_partition;
ALTER TABLE contract_events_partitioned RENAME TO contract_events;
DROP FUNCTION mirror_contract_event_insert();
DROP TABLE contract_events_pre_partition;
COMMIT;

-- The parent has a DEFAULT partition as a safety net; the worker creates future
-- monthly partitions 14 days ahead and archives fully expired ones after 90 days.
