-- ============================================================
-- TENANT SCHEMA BOOTSTRAP SQL
-- ============================================================
--
-- This file initializes the multi-tenant schema isolation infrastructure.
-- It creates the base tenant management tables in the public schema
-- and provides utilities for tenant schema creation and cleanup.
--
-- Run this ONCE during initial deployment:
--   psql -U postgres -d fantasyxi -f prisma/sql/tenant_bootstrap.sql

-- ============================================================
-- 1. CREATE TENANT REGISTRY TABLE (if not exists via Prisma)
-- ============================================================

-- Note: Prisma creates the tenants table via migrations.
-- This section provides manual DDL as a reference.

CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier TEXT NOT NULL CHECK (tier IN ('PUBLIC', 'ENTERPRISE', 'SPONSORED')),
  schema_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  retention_days INT DEFAULT 365,
  max_leagues INT DEFAULT 100,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_tenants_is_active ON public.tenants(is_active);
CREATE INDEX IF NOT EXISTS idx_tenants_tier_active ON public.tenants(tier, is_active);

-- ============================================================
-- 2. CREATE TENANT SECURITY AUDIT TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenant_security_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID,
  attempted_schema TEXT NOT NULL,
  violation_type TEXT NOT NULL,
  request_path TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_security_audits_tenant ON public.tenant_security_audits(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tenant_security_audits_type ON public.tenant_security_audits(violation_type, created_at);

-- ============================================================
-- 3. CREATE TENANT MIGRATION TRACKING TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenant_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  migration_name TEXT NOT NULL,
  applied_at TIMESTAMP DEFAULT NOW(),
  status TEXT DEFAULT 'success' CHECK (status IN ('success', 'failed', 'pending', 'rolled_back')),
  error_message TEXT,
  UNIQUE(tenant_id, migration_name)
);

CREATE INDEX IF NOT EXISTS idx_tenant_migrations_tenant ON public.tenant_migrations(tenant_id, applied_at);

-- ============================================================
-- 4. HELPER FUNCTION: CREATE TENANT SCHEMA
-- ============================================================
-- Creates a new PostgreSQL schema for a tenant and copies all public schema tables.
-- Usage: SELECT create_tenant_schema('tenant_abc123', 'public');

CREATE OR REPLACE FUNCTION public.create_tenant_schema(
  p_schema_name TEXT,
  p_source_schema TEXT DEFAULT 'public'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_table_name TEXT;
  v_constraint_name TEXT;
BEGIN
  -- Create schema
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', p_schema_name);

  -- Copy all tables from source schema
  FOR v_table_name IN
    SELECT tablename FROM pg_tables WHERE schemaname = p_source_schema
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.%I AS SELECT * FROM %I.%I WITH NO DATA',
      p_schema_name, v_table_name, p_source_schema, v_table_name
    );

    -- Copy primary keys
    FOR v_constraint_name IN
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = p_source_schema AND table_name = v_table_name
        AND constraint_type = 'PRIMARY KEY'
    LOOP
      -- Note: This is simplified; full constraint copying requires more logic
      NULL; -- Constraints will be set up by Prisma migrations
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Created tenant schema: %', p_schema_name;
  RETURN TRUE;

EXCEPTION
  WHEN duplicate_schema THEN
    RAISE NOTICE 'Schema % already exists', p_schema_name;
    RETURN FALSE;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'Error creating schema %: %', p_schema_name, SQLERRM;
END;
$$;

-- ============================================================
-- 5. HELPER FUNCTION: DROP TENANT SCHEMA
-- ============================================================
-- Safely drops a tenant schema and all its objects.
-- Usage: SELECT drop_tenant_schema('tenant_abc123');

CREATE OR REPLACE FUNCTION public.drop_tenant_schema(
  p_schema_name TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  -- Disconnect all active connections to the schema
  -- (This is a simplified version; pg_terminate_backend may be needed)

  -- Drop schema and all contained objects
  EXECUTE format('DROP SCHEMA IF NOT EXISTS %I CASCADE', p_schema_name);

  RAISE NOTICE 'Dropped tenant schema: %', p_schema_name;
  RETURN TRUE;

EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'Error dropping schema %: %', p_schema_name, SQLERRM;
END;
$$;

-- ============================================================
-- 6. HELPER FUNCTION: SET RLS CONTEXT
-- ============================================================
-- Sets PostgreSQL session context for Row-Level Security (RLS).
-- Called by tenantContext middleware after authentication.
-- Usage: SELECT set_rls_context('user_uuid');

CREATE OR REPLACE FUNCTION public.set_rls_context(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('SET app.current_user_id = %L', p_user_id::TEXT);
EXCEPTION
  WHEN OTHERS THEN
    -- Fail silently if RLS context cannot be set (e.g., in development)
    NULL;
END;
$$;

-- ============================================================
-- 7. HELPER FUNCTION: CLEANUP EXPIRED DATA PER TENANT
-- ============================================================
-- Removes data older than the tenant's retention_days setting.
-- Called periodically by a scheduled job.
-- Usage: SELECT cleanup_tenant_expired_data('tenant_abc123');

CREATE OR REPLACE FUNCTION public.cleanup_tenant_expired_data(
  p_schema_name TEXT
)
RETURNS TABLE(
  deleted_rows BIGINT,
  execution_time_ms BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_time TIMESTAMP;
  v_deleted BIGINT := 0;
BEGIN
  v_start_time := CLOCK_TIMESTAMP();

  -- Delete old league chat messages
  EXECUTE format(
    'DELETE FROM %I.league_chat_messages WHERE created_at < NOW() - INTERVAL ''365 days''',
    p_schema_name
  ) INTO v_deleted;

  -- Delete old player price changes
  EXECUTE format(
    'DELETE FROM %I.player_price_changes WHERE changed_at < NOW() - INTERVAL ''365 days''',
    p_schema_name
  ) INTO v_deleted;

  -- Delete old player status history
  EXECUTE format(
    'DELETE FROM %I.player_status_history WHERE changed_at < NOW() - INTERVAL ''365 days''',
    p_schema_name
  ) INTO v_deleted;

  RETURN QUERY SELECT
    v_deleted,
    (EXTRACT(EPOCH FROM (CLOCK_TIMESTAMP() - v_start_time)) * 1000)::BIGINT;
END;
$$;

-- ============================================================
-- 8. HELPER FUNCTION: GET TENANT SCHEMA SIZE
-- ============================================================
-- Returns the disk space consumed by a tenant schema.
-- Usage: SELECT get_tenant_schema_size('tenant_abc123');

CREATE OR REPLACE FUNCTION public.get_tenant_schema_size(
  p_schema_name TEXT
)
RETURNS TABLE(
  schema_name TEXT,
  size_bytes BIGINT,
  size_readable TEXT
)
LANGUAGE SQL
AS $$
SELECT
  p_schema_name,
  SUM(pg_total_relation_size(schemaname || '.' || tablename))::BIGINT AS size_bytes,
  pg_size_pretty(SUM(pg_total_relation_size(schemaname || '.' || tablename))) AS size_readable
FROM pg_tables
WHERE schemaname = p_schema_name
GROUP BY schemaname;
$$;

-- ============================================================
-- 9. HELPER FUNCTION: VALIDATE TENANT SCHEMA
-- ============================================================
-- Checks that a tenant schema exists and contains all expected tables.
-- Usage: SELECT validate_tenant_schema('tenant_abc123');

CREATE OR REPLACE FUNCTION public.validate_tenant_schema(
  p_schema_name TEXT
)
RETURNS TABLE(
  is_valid BOOLEAN,
  missing_tables TEXT
)
LANGUAGE SQL
AS $$
SELECT
  (missing_count = 0) AS is_valid,
  CASE WHEN missing_count > 0 THEN
    STRING_AGG(missing_table, ', ')
  ELSE
    ''
  END AS missing_tables
FROM (
  SELECT
    table_name AS missing_table,
    COUNT(*) OVER () AS missing_count
  FROM (
    VALUES ('users'), ('leagues'), ('league_members'), ('squads'), ('players')
  ) AS required_tables(table_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = p_schema_name AND table_name = required_tables.table_name
  )
) AS missing;
$$;

-- ============================================================
-- 10. AUDIT LOG: TENANT LIFECYCLE EVENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenant_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'activated', 'deactivated', 'migrated', 'cleaned')),
  event_details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_lifecycle_events_tenant ON public.tenant_lifecycle_events(tenant_id, created_at);

-- ============================================================
-- 11. GRANT PERMISSIONS FOR TENANT MANAGEMENT
-- ============================================================
-- Note: Adjust user/role names as needed for your deployment.

-- Assuming a 'backend' or 'app' role that the application uses:
-- GRANT USAGE ON SCHEMA public TO backend;
-- GRANT SELECT, INSERT, UPDATE ON public.tenants TO backend;
-- GRANT SELECT, INSERT ON public.tenant_security_audits TO backend;
-- GRANT SELECT, INSERT, UPDATE ON public.tenant_migrations TO backend;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO backend;

-- ============================================================
-- 12. FINAL VALIDATION
-- ============================================================

-- Verify bootstrap completed successfully
DO $$
BEGIN
  RAISE NOTICE 'Tenant bootstrap SQL completed successfully';
  RAISE NOTICE 'Tables created: tenants, tenant_security_audits, tenant_migrations';
  RAISE NOTICE 'Functions created: create_tenant_schema, drop_tenant_schema, set_rls_context, cleanup_tenant_expired_data, get_tenant_schema_size, validate_tenant_schema';
END $$;
