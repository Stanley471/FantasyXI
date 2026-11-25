BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE financial_merkle_entries (
  sequence bigint PRIMARY KEY,
  audit_id text NOT NULL UNIQUE,
  transaction_id text,
  payload_text text NOT NULL,
  previous_hash char(64) NOT NULL,
  hash char(64) NOT NULL UNIQUE,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX financial_merkle_transaction ON financial_merkle_entries(transaction_id,sequence);
CREATE TABLE financial_merkle_roots (
  hour timestamptz PRIMARY KEY,
  first_sequence bigint NOT NULL, last_sequence bigint NOT NULL,
  entry_count integer NOT NULL, root char(64) NOT NULL,
  receipt text NOT NULL, published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION append_financial_merkle_row(source_row jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE prior char(64); next_sequence bigint; payload text;
BEGIN
  PERFORM pg_advisory_xact_lock(45119001);
  SELECT hash,sequence+1 INTO prior,next_sequence FROM financial_merkle_entries ORDER BY sequence DESC LIMIT 1;
  prior := coalesce(prior,repeat('0',64)); next_sequence := coalesce(next_sequence,1);
  payload := source_row::text;
  INSERT INTO financial_merkle_entries(sequence,audit_id,transaction_id,payload_text,previous_hash,hash)
  VALUES(next_sequence,source_row->>'id',source_row->>'transaction_id',payload,prior,encode(digest(prior||payload,'sha256'),'hex'));
END $$;
CREATE FUNCTION capture_financial_merkle_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM append_financial_merkle_row(to_jsonb(NEW)); RETURN NEW; END $$;
-- Capture and backfill under one table lock: no write can escape between them.
LOCK TABLE financial_audit_logs IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE source_row record; BEGIN
  FOR source_row IN SELECT * FROM financial_audit_logs ORDER BY created_at,id LOOP
    PERFORM append_financial_merkle_row(to_jsonb(source_row));
  END LOOP;
END $$;
CREATE TRIGGER financial_merkle_capture AFTER INSERT ON financial_audit_logs
FOR EACH ROW EXECUTE FUNCTION capture_financial_merkle_row();
CREATE FUNCTION reject_financial_merkle_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial audit evidence is append-only'; END $$;
CREATE TRIGGER financial_merkle_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON financial_merkle_entries
FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_merkle_mutation();
CREATE TRIGGER financial_root_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON financial_merkle_roots
FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_merkle_mutation();
CREATE TRIGGER financial_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON financial_audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_merkle_mutation();
-- Capture committed financial writes in their own transaction, independently of
-- the older best-effort application audit buffer (which may drop during outages).
CREATE FUNCTION capture_financial_state_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action_name "FinancialAuditAction";
BEGIN
  action_name := CASE
    WHEN NEW.type='REFUND' THEN 'REFUND'
    WHEN NEW.type='PLATFORM_FEE' THEN 'FEE_EXTRACTION'
    WHEN NEW.type='PRIZE_PAYOUT' THEN 'WITHDRAWAL'
    WHEN NEW.status='CONFIRMED' THEN 'DEPOSIT_CONFIRMED'
    WHEN NEW.status='FAILED' THEN 'DEPOSIT_FAILED'
    ELSE 'DEPOSIT_SUBMITTED' END;
  INSERT INTO financial_audit_logs(id,action,user_id,actor_id,league_id,transaction_id,amount,asset,stellar_tx_hash,metadata,created_at)
  VALUES(gen_random_uuid()::text,action_name,NEW.user_id,'database:'||session_user,NEW.league_id,NEW.id,NEW.amount,NEW.asset,NEW.stellar_tx_hash,
    jsonb_build_object('operation',TG_OP,'status',NEW.status,'type',NEW.type,'transaction_snapshot',to_jsonb(NEW)),clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER financial_state_capture AFTER INSERT OR UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION capture_financial_state_change();
CREATE TRIGGER financial_transaction_no_delete BEFORE DELETE OR TRUNCATE ON transactions
FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_merkle_mutation();
-- Establish a verifiable current-state baseline for historical transactions too.
INSERT INTO financial_audit_logs(id,action,user_id,actor_id,league_id,transaction_id,amount,asset,stellar_tx_hash,metadata,created_at)
SELECT gen_random_uuid()::text,'DEPOSIT_SUBMITTED',t.user_id,'database:baseline',t.league_id,t.id,t.amount,t.asset,t.stellar_tx_hash,
  jsonb_build_object('operation','BASELINE','status',t.status,'type',t.type,'transaction_snapshot',to_jsonb(t)),clock_timestamp()
FROM transactions t;
COMMIT;
