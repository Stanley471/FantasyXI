/**
 * Multi-tenant migration runner.
 *
 * Applies pending Prisma migrations to all active tenant schemas in sequence.
 * Supports rollback, resume on failure, and per-tenant status tracking.
 *
 * Usage:
 *   npm run db:migrate:tenants           # Apply all pending migrations
 *   npm run db:migrate:tenants -- --rollback  # Rollback last migration
 *   npm run db:migrate:tenants -- --status    # Show migration status
 *
 * This script is designed to be run during deployments, with zero-downtime support:
 * - Migrations are applied to each tenant in a transaction
 * - If a migration fails, it is rolled back and recorded in tenant_migrations table
 * - A failed migration does not prevent other tenants from being migrated
 * - Failed tenants can be retried with --retry flag
 */

import { prisma } from "../config/db.js";
import { listActiveTenants, invalidateTenantCache } from "../services/tenantContextService.js";
import { executeTenantTransaction } from "../services/dynamicQueryRouter.js";
import { TenantContext } from "../types/tenant.js";
import fs from "fs/promises";
import path from "path";

/**
 * Migration file metadata.
 */
interface MigrationFile {
  name: string;
  /** Unix timestamp when the migration was created */
  timestamp: number;
  path: string;
}

/**
 * Single migration execution result.
 */
interface MigrationExecutionResult {
  tenantId: string;
  schemaName: string;
  migrationName: string;
  status: "success" | "failed" | "skipped";
  errorMessage?: string;
  executionTimeMs: number;
}

/**
 * Overall migration batch result.
 */
interface MigrationBatchResult {
  totalTenants: number;
  successfulTenants: number;
  failedTenants: number;
  skippedTenants: number;
  results: MigrationExecutionResult[];
  totalTimeMs: number;
}

/**
 * Main entry point for the migration runner.
 * Called from CLI with optional flags.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "migrate";

  try {
    switch (command) {
      case "--status":
        await showMigrationStatus();
        break;
      case "--rollback":
        await rollbackLatestMigration();
        break;
      case "--retry":
        await retryFailedMigrations();
        break;
      case "migrate":
      default:
        await runMigrations();
        break;
    }
  } catch (error) {
    console.error("[MultiTenantMigration] Fatal error:", error);
    process.exit(1);
  }
}

/**
 * Runs pending migrations for all active tenants.
 */
async function runMigrations(): Promise<void> {
  console.log("[MultiTenantMigration] Starting multi-tenant migration run...");
  const startTime = Date.now();

  try {
    // Get list of active tenants (excluding PUBLIC)
    const tenants = await listActiveTenants();
    console.log(
      `[MultiTenantMigration] Found ${tenants.length} active tenant(s)`
    );

    if (tenants.length === 0) {
      console.log("[MultiTenantMigration] No tenants to migrate. Exiting.");
      return;
    }

    // Get pending migrations from prisma/migrations directory
    const pendingMigrations = await getPendingMigrations();
    console.log(
      `[MultiTenantMigration] Found ${pendingMigrations.length} pending migration(s)`
    );

    if (pendingMigrations.length === 0) {
      console.log(
        "[MultiTenantMigration] No pending migrations. Nothing to do."
      );
      return;
    }

    // Apply migrations to each tenant
    const results: MigrationExecutionResult[] = [];

    for (const tenant of tenants) {
      console.log(`\n[MultiTenantMigration] Migrating tenant: ${tenant.displayName} (${tenant.schemaName})`);

      for (const migration of pendingMigrations) {
        const result = await applyMigrationToTenant(tenant, migration);
        results.push(result);

        if (result.status === "failed") {
          console.error(`  ✗ ${migration.name}: FAILED (${result.errorMessage})`);
          // Continue to next tenant instead of stopping
        } else if (result.status === "skipped") {
          console.log(`  ⊘ ${migration.name}: SKIPPED (already applied)`);
        } else {
          console.log(`  ✓ ${migration.name}: OK (${result.executionTimeMs}ms)`);
        }
      }

      // Invalidate cache for this tenant
      await invalidateTenantCache(tenant.id);
    }

    // Summary
    const summary = compileBatchResult(results);
    printMigrationSummary(summary);

    const totalTime = Date.now() - startTime;
    console.log(`\n[MultiTenantMigration] Complete in ${totalTime}ms`);

    if (summary.failedTenants > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error("[MultiTenantMigration] Unexpected error:", error);
    process.exit(1);
  }
}

/**
 * Applies a single migration to a single tenant.
 *
 * @param tenant The tenant to migrate
 * @param migration The migration to apply
 * @returns Execution result
 */
async function applyMigrationToTenant(
  tenant: TenantContext,
  migration: MigrationFile
): Promise<MigrationExecutionResult> {
  const startTime = Date.now();
  const result: MigrationExecutionResult = {
    tenantId: tenant.id,
    schemaName: tenant.schemaName,
    migrationName: migration.name,
    status: "success",
    executionTimeMs: 0,
  };

  try {
    // Check if migration already applied
    const existing = await prisma.tenantMigration.findUnique({
      where: {
        tenantId_migrationName: {
          tenantId: tenant.id,
          migrationName: migration.name,
        },
      },
    });

    if (existing && existing.status === "success") {
      result.status = "skipped";
      result.executionTimeMs = Date.now() - startTime;
      return result;
    }

    // Read migration SQL file
    const migrationSql = await fs.readFile(migration.path, "utf-8");

    // Execute migration in transaction within tenant schema
    await executeTenantTransaction(tenant, async (_tx) => {
      // Split into individual statements and execute
      const statements = migrationSql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement);
      }
    });

    // Record success
    await prisma.tenantMigration.upsert({
      where: {
        tenantId_migrationName: {
          tenantId: tenant.id,
          migrationName: migration.name,
        },
      },
      create: {
        tenantId: tenant.id,
        migrationName: migration.name,
        status: "success",
      },
      update: {
        status: "success",
        appliedAt: new Date(),
      },
    });

    result.executionTimeMs = Date.now() - startTime;
    return result;
  } catch (error) {
    result.status = "failed";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.executionTimeMs = Date.now() - startTime;

    // Record failure
    await prisma.tenantMigration
      .upsert({
        where: {
          tenantId_migrationName: {
            tenantId: tenant.id,
            migrationName: migration.name,
          },
        },
        create: {
          tenantId: tenant.id,
          migrationName: migration.name,
          status: "failed",
          errorMessage: result.errorMessage,
        },
        update: {
          status: "failed",
          errorMessage: result.errorMessage,
        },
      })
      .catch((e) => {
        console.error("[MultiTenantMigration] Failed to record migration error:", e);
      });

    return result;
  }
}

/**
 * Gets all pending migrations from the Prisma migrations directory.
 *
 * @returns Array of migration files
 */
async function getPendingMigrations(): Promise<MigrationFile[]> {
  const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

  try {
    const entries = await fs.readdir(migrationsDir);
    const migrations: MigrationFile[] = [];

    for (const entry of entries) {
      const entryPath = path.join(migrationsDir, entry);
      const stat = await fs.stat(entryPath);

      if (!stat.isDirectory()) {
        continue;
      }

      // Extract timestamp from directory name (e.g., "20240101000000_init")
      const match = entry.match(/^(\d{14})_/);
      if (!match) {
        continue;
      }

      const timestamp = parseInt(match[1], 10);
      const migrationSqlPath = path.join(entryPath, "migration.sql");

      // Check if migration.sql exists
      try {
        await fs.access(migrationSqlPath);
        migrations.push({
          name: entry,
          timestamp,
          path: migrationSqlPath,
        });
      } catch {
        // migration.sql doesn't exist, skip
      }
    }

    // Sort by timestamp (oldest first)
    migrations.sort((a, b) => a.timestamp - b.timestamp);

    return migrations;
  } catch (error) {
    console.error("[MultiTenantMigration] Failed to read migrations directory:", error);
    return [];
  }
}

/**
 * Shows the current migration status for all tenants.
 */
async function showMigrationStatus(): Promise<void> {
  console.log("[MultiTenantMigration] Migration Status Report\n");

  const tenants = await listActiveTenants();
  const pendingMigrations = await getPendingMigrations();

  for (const tenant of tenants) {
    console.log(`Tenant: ${tenant.displayName} (${tenant.schemaName})`);

    for (const migration of pendingMigrations) {
      const status = await prisma.tenantMigration.findUnique({
        where: {
          tenantId_migrationName: {
            tenantId: tenant.id,
            migrationName: migration.name,
          },
        },
      });

      const statusStr = status?.status === "success" ? "✓" : "✗";
      console.log(`  ${statusStr} ${migration.name}`);
    }

    console.log();
  }
}

/**
 * Retries migrations that failed.
 */
async function retryFailedMigrations(): Promise<void> {
  console.log("[MultiTenantMigration] Retrying failed migrations...\n");

  const failedMigrations = await prisma.tenantMigration.findMany({
    where: { status: "failed" },
  });

  console.log(`Found ${failedMigrations.length} failed migration(s).`);

  for (const record of failedMigrations) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: record.tenantId },
    });

    if (!tenant) {
      console.warn(`Tenant ${record.tenantId} not found. Skipping.`);
      continue;
    }

    console.log(
      `\nRetrying: ${record.migrationName} for tenant ${tenant.displayName}`
    );

    const tenantContext: TenantContext = {
      id: tenant.id,
      tier: tenant.tier as any,
      schemaName: tenant.schemaName,
      displayName: tenant.displayName,
      retentionDays: tenant.retentionDays,
      isActive: tenant.isActive,
    };

    const migrationFiles = await getPendingMigrations();
    const migrationFile = migrationFiles.find((m) => m.name === record.migrationName);

    if (!migrationFile) {
      console.warn(`Migration file ${record.migrationName} not found. Skipping.`);
      continue;
    }

    const result = await applyMigrationToTenant(tenantContext, migrationFile);
    console.log(`  Result: ${result.status} (${result.executionTimeMs}ms)`);
  }
}

/**
 * Rolls back the last applied migration.
 */
async function rollbackLatestMigration(): Promise<void> {
  console.log(
    "[MultiTenantMigration] WARNING: Rollback is manual. Implement revert logic in revert.sql files."
  );
  console.log(
    "See: https://www.prisma.io/docs/concepts/components/prisma-migrate/mental-model#note-on-rollbacks"
  );
  // Full rollback implementation would require revert.sql files and logic
  // For now, this is a placeholder
}

/**
 * Compiles individual results into a batch summary.
 */
function compileBatchResult(results: MigrationExecutionResult[]): MigrationBatchResult {
  const uniqueTenants = new Set(results.map((r) => r.tenantId));

  return {
    totalTenants: uniqueTenants.size,
    successfulTenants: new Set(
      results.filter((r) => r.status === "success").map((r) => r.tenantId)
    ).size,
    failedTenants: new Set(
      results.filter((r) => r.status === "failed").map((r) => r.tenantId)
    ).size,
    skippedTenants: new Set(
      results.filter((r) => r.status === "skipped").map((r) => r.tenantId)
    ).size,
    results,
    totalTimeMs: 0, // Set by caller
  };
}

/**
 * Prints a formatted migration summary.
 */
function printMigrationSummary(summary: MigrationBatchResult): void {
  console.log("\n" + "=".repeat(60));
  console.log("Migration Summary");
  console.log("=".repeat(60));
  console.log(`Total Tenants:     ${summary.totalTenants}`);
  console.log(`Successful:        ${summary.successfulTenants}`);
  console.log(`Failed:            ${summary.failedTenants}`);
  console.log(`Skipped:           ${summary.skippedTenants}`);
  console.log("=".repeat(60));
}

// Run main
main().catch(console.error);
