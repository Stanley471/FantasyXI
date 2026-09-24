# Zero-Downtime Database Schema Migration Guide

This document outlines the standard Expand/Contract pattern and operational rules for executing zero-downtime database migrations in FantasyXI.

---

## 1. Expand / Contract Pattern Overview

To ensure uninterrupted service (zero-downtime) during database migrations, schema changes must be split into multiple backward-compatible phases rather than executed in a single destructive step.

```
       Phase 1: EXPAND                  Phase 2: DUAL WRITE / READ           Phase 3: CONTRACT
  ┌────────────────────────┐            ┌──────────────────────────┐         ┌────────────────────────┐
  │ Add new column/table.  │ ─────────► │ Deploy application.      │ ──────► │ Remove old column/table│
  │ Keep old column intact.│            │ Read from new, write both│         │ after all nodes updated│
  └────────────────────────┘            └──────────────────────────┘         └────────────────────────┘
```

### Safe vs Unsafe Operations

| Operation | Safety | Expand/Contract Strategy |
| :--- | :--- | :--- |
| **Add optional column (`NULL`)** | ✅ Safe | Expand: Add column without `NOT NULL` constraint or with default. |
| **Add column with `DEFAULT`** | ✅ Safe | Expand: Set default value so existing inserts without column succeed. |
| **Rename column** | ❌ Unsafe | 1. Expand: Add new column.<br>2. Dual-write to both old and new columns.<br>3. Backfill data.<br>4. Contract: Drop old column in next release. |
| **Drop column** | ❌ Unsafe | 1. Stop reading/writing old column in application release N.<br>2. Contract: Drop column in release N+1. |
| **Add `NOT NULL` constraint** | ❌ Unsafe | 1. Add column as nullable.<br>2. Backfill existing null rows.<br>3. Add `NOT NULL` constraint in follow-up migration. |

---

## 2. Automated Migration Validator

Before committing any migration file, run the migration validator to check for destructive SQL or schema breaking changes:

```bash
npm run db:validate-migration
```

The migration validator scans proposed SQL migration scripts for:
- Unsafe `DROP COLUMN` or `DROP TABLE` statements.
- Direct `RENAME COLUMN` or `RENAME TABLE` operations.
- Non-nullable columns added without default values.

---

## 3. Application Startup Compatibility

The application verifies schema version compatibility upon startup via `checkSchemaCompatibility()` in `src/config/db.ts`. 

If a migration is in progress (N / N+1 schema state), the application gracefully falls back to compatible query strategies without throwing 500 errors to active users.

---

## 4. Deployment Pipeline

The zero-downtime migration pipeline runs automatically on deployment:

1. **Pre-deploy**: Run `npm run db:validate-migration` in CI.
2. **Migration (Expand Phase)**: Execute `npx prisma migrate deploy`.
3. **Application Rollout**: Deploy updated backend application instances.
4. **Post-deploy Cleanup (Contract Phase)**: Schedule cleanup migrations only after all nodes run code compatible with the new schema version.
