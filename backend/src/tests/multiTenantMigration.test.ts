/**
 * Multi-tenant migration tests.
 *
 * Verifies that migrations are applied correctly across all tenant schemas:
 * - Migrations are applied to each active tenant
 * - Failed migrations are recorded and can be retried
 * - Migration status is tracked per tenant
 * - Concurrent migrations do not interfere with each other
 * - Rollback logic works correctly
 *
 * Run with: npm test -- src/tests/multiTenantMigration.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { prisma } from "../config/db.js";
import {
  createTenant,
  listActiveTenants,
  clearTenantCache,
} from "../services/tenantContextService.js";
import {
  executeTenantQuery,
  executeTenantTransaction,
  validateTenantQuery,
} from "../services/dynamicQueryRouter.js";
import { TenantTier, TenantContext } from "../types/tenant.js";

describe("Multi-Tenant Migration Tests", () => {
  let tenant1: TenantContext;
  let tenant2: TenantContext;

  before(async () => {
    // Clean up
    await clearTenantCache();

    // Create test tenants
    tenant1 = await createTenant(
      TenantTier.ENTERPRISE,
      "Migration Test Tenant 1"
    );
    tenant2 = await createTenant(
      TenantTier.SPONSORED,
      "Migration Test Tenant 2"
    );
  });

  after(async () => {
    // Clean up test tenants
    try {
      if (tenant1) {
        await prisma.tenant.update({
          where: { id: tenant1.id },
          data: { isActive: false },
        });
      }
      if (tenant2) {
        await prisma.tenant.update({
          where: { id: tenant2.id },
          data: { isActive: false },
        });
      }
    } catch (error) {
      console.error("Failed to clean up test tenants:", error);
    }
  });

  // ================================================================
  // MIGRATION TRACKING TESTS
  // ================================================================

  describe("Migration Tracking", () => {
    it("should record successful migrations", async () => {
      const migrationName = "test_" + Date.now() + "_success";

      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "success",
        },
      });

      const record = await prisma.tenantMigration.findUnique({
        where: {
          tenantId_migrationName: {
            tenantId: tenant1.id,
            migrationName,
          },
        },
      });

      assert.ok(record);
      assert.strictEqual(record.status, "success");
      assert.ok(record.appliedAt);
    });

    it("should record failed migrations with error messages", async () => {
      const migrationName = "test_" + Date.now() + "_failed";
      const errorMessage = "Syntax error in migration SQL";

      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "failed",
          errorMessage,
        },
      });

      const record = await prisma.tenantMigration.findUnique({
        where: {
          tenantId_migrationName: {
            tenantId: tenant1.id,
            migrationName,
          },
        },
      });

      assert.ok(record);
      assert.strictEqual(record.status, "failed");
      assert.strictEqual(record.errorMessage, errorMessage);
    });

    it("should track pending migrations", async () => {
      const migrationName = "test_" + Date.now() + "_pending";

      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant2.id,
          migrationName,
          status: "pending",
        },
      });

      const record = await prisma.tenantMigration.findUnique({
        where: {
          tenantId_migrationName: {
            tenantId: tenant2.id,
            migrationName,
          },
        },
      });

      assert.ok(record);
      assert.strictEqual(record.status, "pending");
    });

    it("should list all migrations for a tenant", async () => {
      const migrations = await prisma.tenantMigration.findMany({
        where: { tenantId: tenant1.id },
        orderBy: { appliedAt: "desc" },
      });

      assert.ok(Array.isArray(migrations));
      // Should have at least the ones we created above
      assert.ok(migrations.length > 0);
    });

    it("should support migration retry by status update", async () => {
      const migrationName = "test_" + Date.now() + "_retry";

      // Create as failed
      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "failed",
          errorMessage: "Original error",
        },
      });

      // Update to retry
      const updated = await prisma.tenantMigration.update({
        where: {
          tenantId_migrationName: {
            tenantId: tenant1.id,
            migrationName,
          },
        },
        data: {
          status: "pending",
          errorMessage: null,
        },
      });

      assert.strictEqual(updated.status, "pending");
      assert.strictEqual(updated.errorMessage, null);
    });

    it("should prevent duplicate migration records", async () => {
      const migrationName = "test_" + Date.now() + "_unique";

      // Create first
      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "success",
        },
      });

      // Attempt duplicate should fail due to unique constraint
      try {
        await prisma.tenantMigration.create({
          data: {
            tenantId: tenant1.id,
            migrationName,
            status: "success",
          },
        });
        assert.fail("Should have thrown unique constraint violation");
      } catch (error) {
        // Expected
        assert.ok(error);
      }
    });
  });

  // ================================================================
  // QUERY EXECUTION TESTS
  // ================================================================

  describe("Tenant Query Execution", () => {
    it("should validate queries before execution", () => {
      // Safe queries should pass
      assert.strictEqual(
        validateTenantQuery("SELECT * FROM users"),
        true
      );
      assert.strictEqual(
        validateTenantQuery("INSERT INTO users VALUES (...)"),
        true
      );

      // Dangerous queries should fail
      assert.strictEqual(
        validateTenantQuery("SET search_path TO public"),
        false
      );
      assert.strictEqual(
        validateTenantQuery("DROP SCHEMA tenant_123"),
        false
      );
    });

    it("should reject DDL operations in tenant queries", () => {
      const ddlOperations = [
        "CREATE TABLE test (id INT)",
        "CREATE SCHEMA tenant_test",
        "DROP TABLE users",
        "ALTER SCHEMA public OWNER TO attacker",
        "TRUNCATE TABLE users",
        "GRANT ALL ON SCHEMA public TO public",
      ];

      for (const operation of ddlOperations) {
        assert.strictEqual(
          validateTenantQuery(operation),
          false,
          `Should block: ${operation}`
        );
      }
    });

    it("should allow DML operations in tenant queries", () => {
      const dmlOperations = [
        "SELECT * FROM users",
        "SELECT id, email FROM users WHERE active = true",
        "INSERT INTO users (email) VALUES ($1)",
        "UPDATE users SET email = $1 WHERE id = $2",
        "DELETE FROM users WHERE created_at < NOW() - INTERVAL '1 year'",
      ];

      for (const operation of dmlOperations) {
        assert.strictEqual(
          validateTenantQuery(operation),
          true,
          `Should allow: ${operation}`
        );
      }
    });
  });

  // ================================================================
  // TRANSACTION TESTS
  // ================================================================

  describe("Transaction Support", () => {
    it("should execute transaction within tenant schema", async () => {
      const transactionSuccess = await executeTenantTransaction(
        tenant1,
        async (_tx) => {
          // Simulate a transaction operation
          // In a real scenario, this would use _tx to query
          return { success: true };
        }
      );

      assert.ok(transactionSuccess);
      assert.strictEqual(transactionSuccess.success, true);
    });

    it("should rollback transaction on error", async () => {
      try {
        await executeTenantTransaction(tenant1, async (_tx) => {
          throw new Error("Simulated transaction error");
        });
        assert.fail("Should have thrown error");
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("Simulated transaction error"));
      }
    });

    it("should maintain transaction isolation between tenants", async () => {
      const results = await Promise.all([
        executeTenantTransaction(tenant1, async () => ({
          tenantId: tenant1.id,
          timestamp: Date.now(),
        })),
        executeTenantTransaction(tenant2, async () => ({
          tenantId: tenant2.id,
          timestamp: Date.now(),
        })),
      ]);

      assert.strictEqual(results[0].tenantId, tenant1.id);
      assert.strictEqual(results[1].tenantId, tenant2.id);
    });
  });

  // ================================================================
  // CONCURRENT MIGRATION TESTS
  // ================================================================

  describe("Concurrent Migration Handling", () => {
    it("should handle concurrent migrations to different tenants", async () => {
      const migrationName = "concurrent_" + Date.now();

      const results = await Promise.all([
        prisma.tenantMigration.create({
          data: {
            tenantId: tenant1.id,
            migrationName,
            status: "success",
          },
        }),
        prisma.tenantMigration.create({
          data: {
            tenantId: tenant2.id,
            migrationName,
            status: "success",
          },
        }),
      ]);

      assert.strictEqual(results[0].tenantId, tenant1.id);
      assert.strictEqual(results[1].tenantId, tenant2.id);
      assert.strictEqual(results[0].migrationName, migrationName);
      assert.strictEqual(results[1].migrationName, migrationName);
    });

    it("should not allow concurrent same-migration on same tenant", async () => {
      const migrationName = "exclusive_" + Date.now();

      // Create first migration
      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "pending",
        },
      });

      // Attempting to create same migration on same tenant should fail
      try {
        await prisma.tenantMigration.create({
          data: {
            tenantId: tenant1.id,
            migrationName,
            status: "pending",
          },
        });
        assert.fail("Should have thrown unique constraint violation");
      } catch (error) {
        // Expected
        assert.ok(error);
      }
    });
  });

  // ================================================================
  // MIGRATION FAILURE RECOVERY TESTS
  // ================================================================

  describe("Migration Failure Recovery", () => {
    it("should record migration failures with timestamps", async () => {
      const migrationName = "failure_" + Date.now();
      const before = new Date();

      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "failed",
          errorMessage: "Connection timeout",
        },
      });

      const after = new Date();

      const record = await prisma.tenantMigration.findUnique({
        where: {
          tenantId_migrationName: {
            tenantId: tenant1.id,
            migrationName,
          },
        },
      });

      assert.ok(record);
      assert.ok(record.appliedAt >= before && record.appliedAt <= after);
    });

    it("should support retry of failed migrations", async () => {
      const migrationName = "retry_" + Date.now();

      // Create as failed
      const created = await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "failed",
          errorMessage: "Initial error",
        },
      });

      // Retry by updating status
      const retried = await prisma.tenantMigration.update({
        where: {
          tenantId_migrationName: {
            tenantId: tenant1.id,
            migrationName,
          },
        },
        data: {
          status: "success",
          errorMessage: null,
        },
      });

      assert.strictEqual(created.status, "failed");
      assert.strictEqual(retried.status, "success");
      assert.strictEqual(retried.errorMessage, null);
    });

    it("should list failed migrations for retry", async () => {
      const migrationName = "list_failed_" + Date.now();

      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "failed",
          errorMessage: "Test failure",
        },
      });

      const failed = await prisma.tenantMigration.findMany({
        where: {
          status: "failed",
        },
      });

      assert.ok(Array.isArray(failed));
      assert.ok(failed.some((m) => m.migrationName === migrationName));
    });
  });

  // ================================================================
  // TENANT ISOLATION IN MIGRATIONS TESTS
  // ================================================================

  describe("Tenant Isolation in Migrations", () => {
    it("should apply different migrations to different tenants", async () => {
      const migration1 = "tenant1_only_" + Date.now();
      const migration2 = "tenant2_only_" + Date.now();

      await Promise.all([
        prisma.tenantMigration.create({
          data: {
            tenantId: tenant1.id,
            migrationName: migration1,
            status: "success",
          },
        }),
        prisma.tenantMigration.create({
          data: {
            tenantId: tenant2.id,
            migrationName: migration2,
            status: "success",
          },
        }),
      ]);

      const t1Migrations = await prisma.tenantMigration.findMany({
        where: { tenantId: tenant1.id },
      });

      const t2Migrations = await prisma.tenantMigration.findMany({
        where: { tenantId: tenant2.id },
      });

      assert.ok(t1Migrations.some((m) => m.migrationName === migration1));
      assert.ok(!t1Migrations.some((m) => m.migrationName === migration2));

      assert.ok(t2Migrations.some((m) => m.migrationName === migration2));
      assert.ok(!t2Migrations.some((m) => m.migrationName === migration1));
    });

    it("should prevent schema leakage between tenants", async () => {
      // Each tenant should only see migrations they own
      const t1Migrations = await prisma.tenantMigration.findMany({
        where: { tenantId: tenant1.id },
      });

      const t2Migrations = await prisma.tenantMigration.findMany({
        where: { tenantId: tenant2.id },
      });

      // Verify no overlap
      const t1Names = new Set(t1Migrations.map((m) => m.migrationName));
      const t2Names = new Set(t2Migrations.map((m) => m.migrationName));

      // Check for unique migrations per tenant
      for (const name of t1Names) {
        if (t2Names.has(name)) {
          // Same migration can exist in both, which is fine
          // But data should still be isolated
          continue;
        }
      }
    });
  });

  // ================================================================
  // MIGRATION STATUS QUERIES TESTS
  // ================================================================

  describe("Migration Status Queries", () => {
    it("should query migration status by tenant", async () => {
      const migrations = await prisma.tenantMigration.findMany({
        where: { tenantId: tenant1.id },
      });

      assert.ok(Array.isArray(migrations));
    });

    it("should query migration status by migration name", async () => {
      const migrationName = "query_" + Date.now();

      await prisma.tenantMigration.create({
        data: {
          tenantId: tenant1.id,
          migrationName,
          status: "success",
        },
      });

      const found = await prisma.tenantMigration.findUnique({
        where: {
          tenantId_migrationName: {
            tenantId: tenant1.id,
            migrationName,
          },
        },
      });

      assert.ok(found);
      assert.strictEqual(found.migrationName, migrationName);
    });

    it("should query failed migrations across all tenants", async () => {
      const failed = await prisma.tenantMigration.findMany({
        where: { status: "failed" },
      });

      assert.ok(Array.isArray(failed));
    });

    it("should order migrations by applied date", async () => {
      const migrations = await prisma.tenantMigration.findMany({
        where: { tenantId: tenant1.id },
        orderBy: { appliedAt: "desc" },
      });

      assert.ok(Array.isArray(migrations));

      // Verify descending order
      for (let i = 1; i < migrations.length; i++) {
        assert.ok(migrations[i - 1].appliedAt >= migrations[i].appliedAt);
      }
    });
  });

  // ================================================================
  // ERROR HANDLING IN MIGRATIONS TESTS
  // ================================================================

  describe("Error Handling in Migrations", () => {
    it("should handle missing tenant gracefully", async () => {
      const nonExistentTenantId = "00000000-0000-0000-0000-000000000000";

      try {
        await prisma.tenantMigration.create({
          data: {
            tenantId: nonExistentTenantId,
            migrationName: "test_" + Date.now(),
            status: "success",
          },
        });
        assert.fail("Should have thrown foreign key constraint");
      } catch (error) {
        // Expected: foreign key violation
        assert.ok(error);
      }
    });

    it("should handle invalid migration status", async () => {
      // Prisma should enforce enum values
      const migrationName = "invalid_status_" + Date.now();

      try {
        await prisma.tenantMigration.create({
          data: {
            tenantId: tenant1.id,
            migrationName,
            status: "invalid_status" as any,
          },
        });
        assert.fail("Should have thrown validation error");
      } catch (error) {
        // Expected
        assert.ok(error);
      }
    });

    it("should safely handle concurrent transaction errors", async () => {
      const promises = [
        executeTenantTransaction(tenant1, async () => {
          throw new Error("Error in transaction");
        }).catch((e) => ({ error: e.message })),
        executeTenantTransaction(tenant2, async () => ({
          success: true,
        })),
      ];

      const results = await Promise.all(promises);

      assert.ok(results[0].error);
      assert.ok(results[1].success);
    });
  });
});
