import fs from "fs";
import path from "path";

export interface MigrationValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates SQL migration content for Expand/Contract zero-downtime compliance.
 */
export function validateMigrationSql(sqlContent: string): MigrationValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const lines = sqlContent.split("\n");

  lines.forEach((line, index) => {
    const trimmed = line.trim().toUpperCase();
    const lineNum = index + 1;

    // Check for DROP COLUMN
    if (trimmed.includes("DROP COLUMN")) {
      errors.push(`Line ${lineNum}: Unsafe 'DROP COLUMN' detected. Drop column requires contract phase deprecation cycle.`);
    }

    // Check for DROP TABLE
    if (trimmed.includes("DROP TABLE")) {
      errors.push(`Line ${lineNum}: Unsafe 'DROP TABLE' detected. Drop table requires contract phase deprecation cycle.`);
    }

    // Check for RENAME COLUMN
    if (trimmed.includes("RENAME COLUMN")) {
      errors.push(`Line ${lineNum}: Direct 'RENAME COLUMN' detected. Use Expand/Contract strategy (add column, dual-write, drop old).`);
    }

    // Check for RENAME TO (table rename)
    if (trimmed.includes("RENAME TO") || trimmed.includes("RENAME TABLE")) {
      errors.push(`Line ${lineNum}: Direct table rename detected. Table renames break active application queries.`);
    }

    // Check for NOT NULL without DEFAULT on ALTER TABLE ADD COLUMN
    if (trimmed.includes("ADD COLUMN") && trimmed.includes("NOT NULL") && !trimmed.includes("DEFAULT")) {
      errors.push(`Line ${lineNum}: Adding 'NOT NULL' column without a DEFAULT value locks table and breaks inserts for existing code.`);
    }

    // Warning for ALTER TABLE without CONCURRENTLY (where applicable)
    if (trimmed.includes("CREATE INDEX") && !trimmed.includes("CONCURRENTLY")) {
      warnings.push(`Line ${lineNum}: Index creation should use CONCURRENTLY in production to avoid locking writes.`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * CLI Entrypoint to scan all migration files in prisma/migrations directory.
 */
export function validateAllMigrations(migrationsDir: string): MigrationValidationResult {
  let allValid = true;
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  if (!fs.existsSync(migrationsDir)) {
    return { valid: true, errors: [], warnings: ["No migrations directory found."] };
  }

  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sqlFile = path.join(migrationsDir, entry.name, "migration.sql");
      if (fs.existsSync(sqlFile)) {
        const content = fs.readFileSync(sqlFile, "utf-8");
        const res = validateMigrationSql(content);
        if (!res.valid) {
          allValid = false;
          res.errors.forEach((e) => allErrors.push(`[${entry.name}] ${e}`));
        }
        res.warnings.forEach((w) => allWarnings.push(`[${entry.name}] ${w}`));
      }
    }
  }

  return {
    valid: allValid,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// Run as script if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const migrationsPath = path.resolve(process.cwd(), "prisma/migrations");
  console.log(`🔍 Validating Prisma migrations in ${migrationsPath}...`);
  const result = validateAllMigrations(migrationsPath);

  if (result.warnings.length > 0) {
    console.warn("⚠️ Migration Warnings:");
    result.warnings.forEach((w) => console.warn(`  - ${w}`));
  }

  if (!result.valid) {
    console.error("❌ Backward-compatibility migration validation failed:");
    result.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  } else {
    console.log("✅ All migrations passed zero-downtime Expand/Contract validation.");
  }
}
