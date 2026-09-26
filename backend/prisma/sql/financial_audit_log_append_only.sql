-- Enforces the append-only contract of the financial audit log at the database level.
-- Any UPDATE, DELETE or TRUNCATE on financial_audit_logs is rejected, even when issued
-- by the application role, so audit history cannot be rewritten after the fact.
--
-- Idempotent: safe to re-run after `prisma db push` / on every deploy.
-- Apply with: npm run db:audit-guard

CREATE OR REPLACE FUNCTION financial_audit_logs_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'financial_audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS financial_audit_logs_no_update_delete ON financial_audit_logs;
CREATE TRIGGER financial_audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON financial_audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION financial_audit_logs_reject_mutation();

DROP TRIGGER IF EXISTS financial_audit_logs_no_truncate ON financial_audit_logs;
CREATE TRIGGER financial_audit_logs_no_truncate
  BEFORE TRUNCATE ON financial_audit_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION financial_audit_logs_reject_mutation();
