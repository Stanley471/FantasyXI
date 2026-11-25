-- On-chain audit anchors for settled gameweeks (issue #559).
CREATE TABLE "gameweek_audit_anchors" (
    "id" TEXT NOT NULL,
    "gameweek_id" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "league_count" INTEGER NOT NULL,
    "member_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stellar_tx_hash" TEXT,
    "ledger_seq" INTEGER,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anchored_at" TIMESTAMP(3),

    CONSTRAINT "gameweek_audit_anchors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gameweek_audit_anchors_gameweek_id_key" ON "gameweek_audit_anchors"("gameweek_id");
CREATE UNIQUE INDEX "gameweek_audit_anchors_stellar_tx_hash_key" ON "gameweek_audit_anchors"("stellar_tx_hash");

ALTER TABLE "gameweek_audit_anchors"
  ADD CONSTRAINT "gameweek_audit_anchors_gameweek_id_fkey"
  FOREIGN KEY ("gameweek_id") REFERENCES "gameweeks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A confirmed receipt is immutable: it cannot be deleted, and its digest,
-- snapshot, gameweek and Stellar transaction cannot be rewritten.
CREATE OR REPLACE FUNCTION gameweek_audit_anchors_protect_confirmed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'CONFIRMED' THEN
      RAISE EXCEPTION 'gameweek_audit_anchors: confirmed receipts cannot be deleted'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'CONFIRMED' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.digest IS DISTINCT FROM OLD.digest
    OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.gameweek_id IS DISTINCT FROM OLD.gameweek_id
    OR NEW.stellar_tx_hash IS DISTINCT FROM OLD.stellar_tx_hash
    OR NEW.ledger_seq IS DISTINCT FROM OLD.ledger_seq
  ) THEN
    RAISE EXCEPTION 'gameweek_audit_anchors: confirmed receipts are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gameweek_audit_anchors_immutable
  BEFORE UPDATE OR DELETE ON "gameweek_audit_anchors"
  FOR EACH ROW
  EXECUTE FUNCTION gameweek_audit_anchors_protect_confirmed();
