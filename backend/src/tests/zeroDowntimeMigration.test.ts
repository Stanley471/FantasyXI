import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationSql } from "../scripts/validateMigration.js";
import { checkSchemaCompatibility } from "../config/db.js";

describe("Zero-Downtime Migration Pipeline & Schema Compatibility", () => {
  it("should pass validation for Expand phase SQL (safe column addition)", () => {
    const safeSql = `
      ALTER TABLE "users" ADD COLUMN "referral_code" TEXT;
      CREATE INDEX CONCURRENTLY "users_referral_code_idx" ON "users"("referral_code");
    `;
    const result = validateMigrationSql(safeSql);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it("should reject unsafe DROP COLUMN statement in Expand phase", () => {
    const unsafeSql = `
      ALTER TABLE "users" DROP COLUMN "old_field";
    `;
    const result = validateMigrationSql(unsafeSql);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("DROP COLUMN")));
  });

  it("should reject unsafe direct RENAME COLUMN statement", () => {
    const unsafeSql = `
      ALTER TABLE "users" RENAME COLUMN "old_name" TO "new_name";
    `;
    const result = validateMigrationSql(unsafeSql);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("RENAME COLUMN")));
  });

  it("should reject NOT NULL column addition without default value", () => {
    const unsafeSql = `
      ALTER TABLE "users" ADD COLUMN "new_required_field" TEXT NOT NULL;
    `;
    const result = validateMigrationSql(unsafeSql);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("NOT NULL")));
  });

  it("should perform non-blocking schema compatibility check during application startup", async () => {
    const status = await checkSchemaCompatibility();
    assert.strictEqual(status.isCompatible, true);
    assert.ok(typeof status.version === "string");
  });
});
