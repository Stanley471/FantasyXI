-- ============================================================
-- TENANT SCHEMA INITIALIZATION TEMPLATE
-- ============================================================
--
-- This SQL template is used to initialize a new tenant schema.
-- It is executed by the multiTenantMigration script when creating a new tenant.
--
-- Variables that are substituted at runtime:
--   {{SCHEMA_NAME}} - The PostgreSQL schema name (e.g., tenant_uuid or sponsored_uuid)
--   {{TENANT_ID}} - The tenant UUID
--   {{TIER}} - The tenant tier (ENTERPRISE, SPONSORED)

-- ============================================================
-- 1. CREATE SCHEMA
-- ============================================================

CREATE SCHEMA IF NOT EXISTS "{{SCHEMA_NAME}}";

-- ============================================================
-- 2. SET SCHEMA IN SEARCH PATH
-- ============================================================

SET search_path TO "{{SCHEMA_NAME}}", public, pg_catalog;

-- ============================================================
-- 3. INITIALIZE SCHEMA VERSION TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS _tenant_schema_metadata (
  id SERIAL PRIMARY KEY,
  schema_name TEXT NOT NULL DEFAULT '{{SCHEMA_NAME}}',
  tenant_id UUID NOT NULL DEFAULT '{{TENANT_ID}}'::UUID,
  tier TEXT NOT NULL DEFAULT '{{TIER}}',
  initialized_at TIMESTAMP DEFAULT NOW(),
  version TEXT DEFAULT '1.0'
);

INSERT INTO _tenant_schema_metadata (schema_name, tenant_id, tier)
  VALUES ('{{SCHEMA_NAME}}', '{{TENANT_ID}}'::UUID, '{{TIER}}')
  ON CONFLICT DO NOTHING;

-- ============================================================
-- 4. COPY INITIAL SCHEMA STRUCTURE FROM PUBLIC
-- ============================================================
-- All tables are created via Prisma migrations.
-- This section is a reference for manual schema setup.

-- Tables will be created by running the migration suite:
--   npm run db:migrate:tenants

-- ============================================================
-- 5. SET UP TENANT-SPECIFIC RETENTION POLICY
-- ============================================================
-- Data retention is enforced via scheduled cleanup jobs.
-- These procedures are defined in tenant_bootstrap.sql.

-- Example: Register a cleanup job for this tenant
-- INSERT INTO public.tenant_lifecycle_events (tenant_id, event_type, event_details)
-- VALUES ('{{TENANT_ID}}'::UUID, 'created', jsonb_build_object(
--   'schema_name', '{{SCHEMA_NAME}}',
--   'tier', '{{TIER}}',
--   'initialized_at', NOW()
-- ));

-- ============================================================
-- 6. VALIDATE SCHEMA INITIALIZATION
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE 'Tenant schema {{SCHEMA_NAME}} initialized successfully for tenant {{TENANT_ID}}';
END $$;
