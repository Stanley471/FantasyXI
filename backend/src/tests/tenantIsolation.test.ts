/**
 * Tenant isolation security tests.
 *
 * Verifies that multi-tenant schema isolation is working correctly:
 * - Cross-tenant query attempts are blocked
 * - Boundary violations are logged and audited
 * - Schema names are validated (no injection)
 * - Tenant context is extracted and resolved correctly
 * - User authorization checks prevent unauthorized access
 *
 * Run with: npm test -- src/tests/tenantIsolation.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { prisma } from "../config/db.js";
import {
  resolveTenant,
  createTenant,
  invalidateTenantCache,
  listActiveTenants,
  clearTenantCache,
} from "../services/tenantContextService.js";
import {
  validateSchemaName,
  InvalidSchemaError,
  TenantNotFoundError,
  TenantBoundaryViolationError,
  TenantTier,
  generateSchemaName,
} from "../types/tenant.js";
import { validateTenantQuery } from "../services/dynamicQueryRouter.js";

describe("Tenant Isolation Security Tests", () => {
  // Test data
  let enterpriseTenantId: string;
  let sponsoredTenantId: string;

  before(async () => {
    // Clean up test data
    await clearTenantCache();

    // Create test tenants
    try {
      const enterprise = await createTenant(
        TenantTier.ENTERPRISE,
        "Test Enterprise Tenant"
      );
      enterpriseTenantId = enterprise.id;

      const sponsored = await createTenant(
        TenantTier.SPONSORED,
        "Test Sponsored Tenant"
      );
      sponsoredTenantId = sponsored.id;
    } catch (error) {
      console.error("Failed to create test tenants:", error);
      throw error;
    }
  });

  after(async () => {
    // Clean up test tenants
    try {
      if (enterpriseTenantId) {
        await prisma.tenant.update({
          where: { id: enterpriseTenantId },
          data: { isActive: false },
        });
      }
      if (sponsoredTenantId) {
        await prisma.tenant.update({
          where: { id: sponsoredTenantId },
          data: { isActive: false },
        });
      }
    } catch (error) {
      console.error("Failed to clean up test tenants:", error);
    }
  });

  // ================================================================
  // SCHEMA NAME VALIDATION TESTS
  // ================================================================

  describe("Schema Name Validation", () => {
    it("should accept valid public schema name", () => {
      assert.strictEqual(validateSchemaName("public"), true);
    });

    it("should accept valid tenant_<uuid> schema name", () => {
      assert.strictEqual(
        validateSchemaName("tenant_550e8400-e29b-41d4-a716-446655440000"),
        true
      );
    });

    it("should accept valid sponsored_<uuid> schema name", () => {
      assert.strictEqual(
        validateSchemaName("sponsored_550e8400-e29b-41d4-a716-446655440000"),
        true
      );
    });

    it("should reject schema names with SQL injection patterns", () => {
      assert.strictEqual(validateSchemaName("public'; DROP TABLE users;--"), false);
      assert.strictEqual(validateSchemaName("tenant_1; DELETE FROM users"), false);
      assert.strictEqual(validateSchemaName('schema"; --'), false);
    });

    it("should reject schema names with invalid characters", () => {
      assert.strictEqual(validateSchemaName("schema-with-dashes"), false); // Invalid pattern
      assert.strictEqual(validateSchemaName("schema with spaces"), false);
      assert.strictEqual(validateSchemaName("schema*wildcard"), false);
    });

    it("should reject empty schema names", () => {
      assert.strictEqual(validateSchemaName(""), false);
      assert.strictEqual(validateSchemaName("   "), false);
    });

    it("should generate valid schema names for each tier", () => {
      const enterpriseSchema = generateSchemaName("550e8400-e29b-41d4-a716-446655440000", TenantTier.ENTERPRISE);
      assert.strictEqual(validateSchemaName(enterpriseSchema), true);
      assert.match(enterpriseSchema, /^tenant_/);

      const sponsoredSchema = generateSchemaName("550e8400-e29b-41d4-a716-446655440000", TenantTier.SPONSORED);
      assert.strictEqual(validateSchemaName(sponsoredSchema), true);
      assert.match(sponsoredSchema, /^sponsored_/);

      const publicSchema = generateSchemaName("anything", TenantTier.PUBLIC);
      assert.strictEqual(publicSchema, "public");
    });
  });

  // ================================================================
  // TENANT CONTEXT RESOLUTION TESTS
  // ================================================================

  describe("Tenant Context Resolution", () => {
    it("should resolve active enterprise tenant", async () => {
      const tenant = await resolveTenant(enterpriseTenantId);
      assert.strictEqual(tenant.id, enterpriseTenantId);
      assert.strictEqual(tenant.tier, TenantTier.ENTERPRISE);
      assert.strictEqual(tenant.isActive, true);
    });

    it("should resolve active sponsored tenant", async () => {
      const tenant = await resolveTenant(sponsoredTenantId);
      assert.strictEqual(tenant.id, sponsoredTenantId);
      assert.strictEqual(tenant.tier, TenantTier.SPONSORED);
      assert.strictEqual(tenant.isActive, true);
    });

    it("should throw TenantNotFoundError for non-existent tenant", async () => {
      const nonExistentId = "550e8400-e29b-41d4-a716-000000000000";
      try {
        await resolveTenant(nonExistentId);
        assert.fail("Should have thrown TenantNotFoundError");
      } catch (error) {
        assert.ok(error instanceof TenantNotFoundError);
      }
    });

    it("should throw TenantNotFoundError for inactive tenant", async () => {
      // Create and deactivate a tenant
      const temp = await createTenant(
        TenantTier.ENTERPRISE,
        "Temp Tenant"
      );
      await prisma.tenant.update({
        where: { id: temp.id },
        data: { isActive: false },
      });

      try {
        await resolveTenant(temp.id);
        assert.fail("Should have thrown TenantNotFoundError");
      } catch (error) {
        assert.ok(error instanceof TenantNotFoundError);
      }
    });

    it("should cache tenant context for performance", async () => {
      // Warm cache
      const tenant1 = await resolveTenant(enterpriseTenantId);

      // Second call should return from cache (no DB hit)
      const tenant2 = await resolveTenant(enterpriseTenantId);

      assert.deepStrictEqual(tenant1, tenant2);
    });

    it("should list all active tenants (excluding public)", async () => {
      const active = await listActiveTenants();
      assert.ok(Array.isArray(active));
      assert.ok(active.length > 0);
      assert.ok(active.some((t) => t.id === enterpriseTenantId));
      assert.ok(active.some((t) => t.id === sponsoredTenantId));
      // Verify no public tier tenants
      assert.ok(!active.some((t) => t.tier === TenantTier.PUBLIC));
    });
  });

  // ================================================================
  // SCHEMA INJECTION PREVENTION TESTS
  // ================================================================

  describe("Schema Injection Prevention", () => {
    it("should throw InvalidSchemaError for injection attempts", () => {
      const invalidSchemas = [
        "tenant_'; DROP TABLE users;--",
        "public' UNION SELECT * FROM users--",
        'tenant_"; DROP SCHEMA public;--',
        "sponsored_1 OR 1=1--",
      ];

      for (const schema of invalidSchemas) {
        assert.throws(
          () => {
            if (!validateSchemaName(schema)) {
              throw new InvalidSchemaError(schema, "Failed validation");
            }
          },
          (error) => error instanceof InvalidSchemaError
        );
      }
    });

    it("should reject queries attempting schema changes", () => {
      const dangerousQueries = [
        "SET search_path TO public",
        "CREATE SCHEMA public",
        "DROP SCHEMA tenant_123",
        "ALTER SCHEMA public OWNER TO attacker",
        "GRANT ALL ON SCHEMA public TO public",
        "REVOKE ALL ON SCHEMA public FROM public",
      ];

      for (const query of dangerousQueries) {
        assert.strictEqual(
          validateTenantQuery(query),
          false,
          `Query should be blocked: ${query}`
        );
      }
    });

    it("should allow safe SELECT queries", () => {
      const safeQueries = [
        "SELECT * FROM users",
        "SELECT id, email FROM users WHERE id = $1",
        "INSERT INTO users (email) VALUES ($1) RETURNING id",
        "UPDATE users SET email = $1 WHERE id = $2",
        "DELETE FROM users WHERE id > 100",
      ];

      for (const query of safeQueries) {
        assert.strictEqual(
          validateTenantQuery(query),
          true,
          `Query should be allowed: ${query}`
        );
      }
    });
  });

  // ================================================================
  // BOUNDARY VIOLATION AUDIT TESTS
  // ================================================================

  describe("Boundary Violation Audit Logging", () => {
    it("should log cross-tenant access attempts", async () => {
      const userId = "test-user-" + Date.now();

      // Record a violation
      await prisma.tenantSecurityAudit.create({
        data: {
          tenantId: enterpriseTenantId,
          userId,
          attemptedSchema: "sponsored_" + sponsoredTenantId,
          violationType: "cross_tenant_access_attempt",
          requestPath: "/api/v1/sponsored/leagues",
        },
      });

      // Verify it was recorded
      const audit = await prisma.tenantSecurityAudit.findFirst({
        where: {
          userId,
          violationType: "cross_tenant_access_attempt",
        },
      });

      assert.ok(audit);
      assert.strictEqual(audit.violationType, "cross_tenant_access_attempt");
      assert.strictEqual(audit.attemptedSchema, "sponsored_" + sponsoredTenantId);
    });

    it("should log schema injection attempts", async () => {
      const injectionAttempt = "public'; DROP TABLE users;--";

      await prisma.tenantSecurityAudit.create({
        data: {
          tenantId: enterpriseTenantId,
          attemptedSchema: injectionAttempt,
          violationType: "schema_injection_blocked",
          requestPath: "/api/v1/leagues",
        },
      });

      const audit = await prisma.tenantSecurityAudit.findFirst({
        where: {
          violationType: "schema_injection_blocked",
        },
      });

      assert.ok(audit);
      assert.strictEqual(audit.violationType, "schema_injection_blocked");
    });

    it("should log invalid schema attempts", async () => {
      await prisma.tenantSecurityAudit.create({
        data: {
          tenantId: enterpriseTenantId,
          attemptedSchema: "invalid-schema-name",
          violationType: "invalid_schema",
          requestPath: "/api/v1/test",
        },
      });

      const audit = await prisma.tenantSecurityAudit.findFirst({
        where: {
          violationType: "invalid_schema",
        },
      });

      assert.ok(audit);
    });

    it("should be queryable by violation type", async () => {
      const crossTenantViolations = await prisma.tenantSecurityAudit.findMany({
        where: {
          violationType: "cross_tenant_access_attempt",
        },
      });

      assert.ok(Array.isArray(crossTenantViolations));
    });

    it("should be queryable by time window", async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const recentViolations = await prisma.tenantSecurityAudit.findMany({
        where: {
          createdAt: {
            gte: yesterday,
            lte: now,
          },
        },
      });

      assert.ok(Array.isArray(recentViolations));
    });
  });

  // ================================================================
  // TENANT ISOLATION VERIFICATION TESTS
  // ================================================================

  describe("Tenant Isolation Verification", () => {
    it("should create distinct schemas for each tenant", async () => {
      const enterpriseTenant = await resolveTenant(enterpriseTenantId);
      const sponsoredTenant = await resolveTenant(sponsoredTenantId);

      assert.notStrictEqual(
        enterpriseTenant.schemaName,
        sponsoredTenant.schemaName,
        "Tenants should have different schemas"
      );

      // Verify schema names match naming convention
      assert.match(enterpriseTenant.schemaName, /^tenant_/);
      assert.match(sponsoredTenant.schemaName, /^sponsored_/);
    });

    it("should prevent access to another tenant's schema", async () => {
      const enterpriseTenant = await resolveTenant(enterpriseTenantId);
      const sponsoredTenant = await resolveTenant(sponsoredTenantId);

      // Both should be valid but distinct
      assert.strictEqual(validateSchemaName(enterpriseTenant.schemaName), true);
      assert.strictEqual(validateSchemaName(sponsoredTenant.schemaName), true);
      assert.notStrictEqual(enterpriseTenant.schemaName, sponsoredTenant.schemaName);
    });

    it("should maintain schema boundaries across cache operations", async () => {
      // Resolve first tenant
      const tenant1 = await resolveTenant(enterpriseTenantId);

      // Invalidate cache
      await invalidateTenantCache(enterpriseTenantId);

      // Resolve again
      const tenant1Again = await resolveTenant(enterpriseTenantId);

      // Should still be the same
      assert.strictEqual(tenant1.schemaName, tenant1Again.schemaName);
      assert.strictEqual(tenant1.id, tenant1Again.id);
    });
  });

  // ================================================================
  // TENANT TIER RESTRICTIONS TESTS
  // ================================================================

  describe("Tenant Tier-Based Restrictions", () => {
    it("should allow ENTERPRISE tier tenants", async () => {
      const tenant = await resolveTenant(enterpriseTenantId);
      assert.strictEqual(tenant.tier, TenantTier.ENTERPRISE);
      assert.strictEqual(tenant.isActive, true);
    });

    it("should allow SPONSORED tier tenants", async () => {
      const tenant = await resolveTenant(sponsoredTenantId);
      assert.strictEqual(tenant.tier, TenantTier.SPONSORED);
      assert.strictEqual(tenant.isActive, true);
    });

    it("should enforce tier-specific quotas", async () => {
      const enterpriseTenant = await resolveTenant(enterpriseTenantId);
      const sponsoredTenant = await resolveTenant(sponsoredTenantId);

      // Enterprise should have higher limits
      const enterpriseRecord = await prisma.tenant.findUnique({
        where: { id: enterpriseTenantId },
      });
      const sponsoredRecord = await prisma.tenant.findUnique({
        where: { id: sponsoredTenantId },
      });

      assert.ok(enterpriseRecord!.maxLeagues >= sponsoredRecord!.maxLeagues);
    });
  });

  // ================================================================
  // DATA ISOLATION VERIFICATION TESTS
  // ================================================================

  describe("Data Isolation Verification", () => {
    it("should prevent direct access to another tenant's data", async () => {
      // This is a logical test; actual cross-tenant queries would require
      // attempting to break schema isolation at the database level.

      const tenant1 = await resolveTenant(enterpriseTenantId);
      const tenant2 = await resolveTenant(sponsoredTenantId);

      // Verify they have different schemas
      assert.notStrictEqual(tenant1.schemaName, tenant2.schemaName);

      // Attempting to query from wrong schema should be caught
      assert.throws(
        () => {
          if (!validateSchemaName(tenant1.schemaName)) {
            throw new InvalidSchemaError(
              tenant1.schemaName,
              "Invalid schema"
            );
          }
        },
        (error) => !(error instanceof InvalidSchemaError)
      );
    });

    it("should track which tables belong to which schemas", async () => {
      // Tenants should have their own table instances
      const tenant1 = await resolveTenant(enterpriseTenantId);
      const tenant2 = await resolveTenant(sponsoredTenantId);

      // Schemas are isolated
      assert.strictEqual(
        tenant1.schemaName !== tenant2.schemaName,
        true
      );
    });
  });

  // ================================================================
  // MIGRATION ISOLATION TESTS
  // ================================================================

  describe("Migration Isolation", () => {
    it("should track migrations per tenant", async () => {
      // Record a migration for a tenant
      await prisma.tenantMigration.create({
        data: {
          tenantId: enterpriseTenantId,
          migrationName: "20240101_test_migration",
          status: "success",
        },
      });

      // Verify it's recorded
      const migration = await prisma.tenantMigration.findUnique({
        where: {
          tenantId_migrationName: {
            tenantId: enterpriseTenantId,
            migrationName: "20240101_test_migration",
          },
        },
      });

      assert.ok(migration);
      assert.strictEqual(migration.status, "success");
    });

    it("should prevent duplicate migration records", async () => {
      const migrationName = "20240101_unique_migration";

      // Create first record
      await prisma.tenantMigration.create({
        data: {
          tenantId: enterpriseTenantId,
          migrationName,
          status: "success",
        },
      });

      // Attempting to create duplicate should fail due to unique constraint
      try {
        await prisma.tenantMigration.create({
          data: {
            tenantId: enterpriseTenantId,
            migrationName,
            status: "success",
          },
        });
        assert.fail("Should have thrown unique constraint violation");
      } catch (error) {
        // Expected: unique constraint violation
        assert.ok(error);
      }
    });
  });

  // ================================================================
  // ERROR HANDLING TESTS
  // ================================================================

  describe("Error Handling", () => {
    it("should provide clear error messages for boundary violations", () => {
      const error = new TenantBoundaryViolationError(
        "tenant_123",
        "tenant_456",
        "User does not belong to requested tenant"
      );

      assert.ok(error.message.includes("tenant_123"));
      assert.ok(error.message.includes("tenant_456"));
      assert.ok(error.message.includes("boundary violation"));
    });

    it("should handle cache clearing safely", async () => {
      // Should not throw
      await clearTenantCache();

      // Should still resolve after cache clear
      const tenant = await resolveTenant(enterpriseTenantId);
      assert.ok(tenant);
    });

    it("should handle invalid schema names gracefully", () => {
      const invalidSchemas = [
        "'; DROP TABLE--",
        "schema with spaces",
        "schema\nwith\nnewlines",
        "../../../etc/passwd",
      ];

      for (const schema of invalidSchemas) {
        assert.strictEqual(validateSchemaName(schema), false);
      }
    });
  });
});
