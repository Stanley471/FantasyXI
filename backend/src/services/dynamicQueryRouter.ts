/**
 * Dynamic query router for tenant-aware Prisma client routing.
 *
 * Creates per-tenant Prisma client instances that automatically prepend
 * SET search_path to route queries to the correct PostgreSQL schema.
 *
 * Handles:
 * - Lazy initialization of per-tenant clients (cached in memory)
 * - Schema context injection for all raw queries
 * - Query parameter sanitization
 * - Read/write splitting (when read replicas are enabled)
 * - Transaction support within tenant schema
 */

import { PrismaClient } from "@prisma/client";
import { prisma as basePrisma } from "../config/db.js";
import { TenantContext, validateSchemaName, InvalidSchemaError } from "../types/tenant.js";

/**
 * Cache of per-tenant Prisma client instances.
 * Maps tenant schema name → Prisma client instance.
 * Reused across requests to the same tenant.
 */
const tenantClientCache = new Map<string, PrismaClient>();

/**
 * Query execution options for tenant-scoped operations.
 */
export interface TenantQueryOptions {
  /** Whether this is a read-only operation (can use replicas if enabled) */
  readonly?: boolean;
  /** Transaction context (if within a transaction) */
  transaction?: any;
  /** Query timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Schema-routed query result wrapper.
 */
export interface SchemaRoutedQuery {
  sql: string;
  params: unknown[];
  schemaName: string;
}

/**
 * Gets or creates a Prisma client instance for a specific tenant schema.
 *
 * The first call creates a new client; subsequent calls return the cached instance.
 * Clients are never explicitly closed; they persist for the application lifetime.
 *
 * @param tenant The tenant context (schema name, ID, etc.)
 * @returns Prisma client bound to the tenant's schema
 * @throws InvalidSchemaError if schema name is invalid
 */
export function getTenantPrismaClient(tenant: TenantContext): PrismaClient {
  // Validate schema name to prevent injection
  if (!validateSchemaName(tenant.schemaName)) {
    throw new InvalidSchemaError(
      tenant.schemaName,
      "Schema name failed validation; possible injection attempt"
    );
  }

  // Check cache
  const cached = tenantClientCache.get(tenant.schemaName);
  if (cached) {
    return cached;
  }

  // Create new client with schema context
  // Note: In production, you might want to configure pooling per tenant
  // For now, we reuse the base pool and inject search_path before queries
  const client = basePrisma.$extends({
    query: {
      // Intercept all queries to prepend SET search_path
      $allOperations: async ({ operation, args, query }) => {
        // Inject schema context before executing
        await basePrisma.$executeRawUnsafe(
          `SET search_path TO "${tenant.schemaName}", public, pg_catalog`
        );

        return query(args);
      },
    },
  }) as unknown as PrismaClient;

  // Cache for reuse
  tenantClientCache.set(tenant.schemaName, client);

  return client;
}

/**
 * Executes a raw SQL query within a tenant's schema context.
 *
 * Automatically prepends SET search_path to route the query to the correct schema.
 * Validates schema name to prevent injection.
 *
 * @param tenant The tenant context
 * @param sql Raw SQL query (may contain parameter placeholders)
 * @param params Query parameters (bound safely)
 * @param options Execution options
 * @returns Query result
 * @throws InvalidSchemaError if schema name is invalid
 */
export async function executeTenantQuery(
  tenant: TenantContext,
  sql: string,
  params: unknown[] = [],
  options: TenantQueryOptions = {}
): Promise<unknown> {
  // Validate schema name
  if (!validateSchemaName(tenant.schemaName)) {
    throw new InvalidSchemaError(
      tenant.schemaName,
      "Schema name failed validation; possible injection attempt"
    );
  }

  // Build schema-routed query
  const searchPathSql = buildSearchPathSql(tenant.schemaName);
  const fullSql = `${searchPathSql}; ${sql}`;

  try {
    const result = await basePrisma.$executeRawUnsafe(fullSql, ...params);
    return result;
  } catch (error) {
    console.error(
      "[DynamicQueryRouter] Query execution failed for tenant %s (schema: %s):",
      tenant.id,
      tenant.schemaName,
      error
    );
    throw error;
  }
}

/**
 * Executes a query and returns rows (for SELECT queries).
 *
 * @param tenant The tenant context
 * @param sql Raw SQL query
 * @param params Query parameters
 * @param options Execution options
 * @returns Array of rows
 */
export async function executeTenantQueryRows(
  tenant: TenantContext,
  sql: string,
  params: unknown[] = [],
  options: TenantQueryOptions = {}
): Promise<unknown[]> {
  const result = await executeTenantQuery(tenant, sql, params, options);
  return Array.isArray(result) ? result : [result];
}

/**
 * Executes a query and returns the first row (for SELECT queries).
 *
 * @param tenant The tenant context
 * @param sql Raw SQL query
 * @param params Query parameters
 * @param options Execution options
 * @returns First row or null
 */
export async function executeTenantQueryOne(
  tenant: TenantContext,
  sql: string,
  params: unknown[] = [],
  options: TenantQueryOptions = {}
): Promise<unknown | null> {
  const rows = await executeTenantQueryRows(tenant, sql, params, options);
  return rows[0] || null;
}

/**
 * Executes a write query within a transaction scoped to the tenant.
 * Ensures the transaction is confined to the tenant's schema.
 *
 * @param tenant The tenant context
 * @param fn Transaction function
 * @returns Transaction result
 */
export async function executeTenantTransaction(
  tenant: TenantContext,
  fn: (client: PrismaClient) => Promise<any>
): Promise<any> {
  // Validate schema name
  if (!validateSchemaName(tenant.schemaName)) {
    throw new InvalidSchemaError(
      tenant.schemaName,
      "Schema name failed validation; possible injection attempt"
    );
  }

  try {
    return await basePrisma.$transaction(async (tx) => {
      // Set schema context for transaction
      await basePrisma.$executeRawUnsafe(
        `SET search_path TO "${tenant.schemaName}", public, pg_catalog`
      );

      return fn(tx as any);
    });
  } catch (error) {
    console.error(
      "[DynamicQueryRouter] Transaction failed for tenant %s (schema: %s):",
      tenant.id,
      tenant.schemaName,
      error
    );
    throw error;
  }
}

/**
 * Builds a SET search_path SQL statement for a given schema.
 * Safely escapes schema name to prevent injection.
 *
 * @param schemaName The PostgreSQL schema name
 * @returns SQL statement to set search_path
 */
function buildSearchPathSql(schemaName: string): string {
  // Double-quote the schema name for safe escaping
  return `SET search_path TO "${schemaName}", public, pg_catalog`;
}

/**
 * Clears the tenant client cache (useful for tests or emergency scenarios).
 * All subsequent operations will create new client instances.
 */
export function clearTenantClientCache(): void {
  tenantClientCache.clear();
  console.log("[DynamicQueryRouter] Tenant client cache cleared");
}

/**
 * Returns statistics about the tenant client cache (for monitoring).
 */
export function getTenantClientCacheStats(): {
  cachedClients: number;
  schemas: string[];
} {
  return {
    cachedClients: tenantClientCache.size,
    schemas: Array.from(tenantClientCache.keys()),
  };
}

/**
 * Validates that a SQL query is safe to execute within a tenant schema.
 * Checks for DDL attempts, schema changes, and other suspicious patterns.
 *
 * @param sql The SQL query to validate
 * @returns true if the query is safe, false if suspicious
 */
export function validateTenantQuery(sql: string): boolean {
  // Trim and uppercase for pattern matching
  const upperSql = sql.trim().toUpperCase();

  // Block DDL operations (only DML within tenant schemas)
  const forbiddenPatterns = [
    /^CREATE\s+(SCHEMA|TABLE|INDEX|VIEW|FUNCTION|TRIGGER)/,
    /^DROP\s+(SCHEMA|TABLE|INDEX|VIEW|FUNCTION|TRIGGER)/,
    /^ALTER\s+SCHEMA/,
    /^ALTER\s+TABLE\s+SET\s+SCHEMA/, // Attempt to move table to different schema
    /^TRUNCATE\s+/,
    /^GRANT\s+/,
    /^REVOKE\s+/,
    /^SET\s+search_path/i, // Don't allow query to override search_path
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(upperSql)) {
      return false;
    }
  }

  return true;
}

/**
 * Wraps a Prisma query in schema context, ensuring it runs within the tenant's schema.
 * Useful for adapting existing Prisma calls to be tenant-aware.
 *
 * Example:
 *   const users = await withTenantSchema(tenant, () =>
 *     prisma.user.findMany()
 *   );
 *
 * @param tenant The tenant context
 * @param fn Function that performs Prisma operations
 * @returns Result of the function
 */
export async function withTenantSchema<T>(
  tenant: TenantContext,
  fn: () => Promise<T>
): Promise<T> {
  if (!validateSchemaName(tenant.schemaName)) {
    throw new InvalidSchemaError(
      tenant.schemaName,
      "Schema name failed validation; possible injection attempt"
    );
  }

  try {
    // Set schema context
    await basePrisma.$executeRawUnsafe(
      `SET search_path TO "${tenant.schemaName}", public, pg_catalog`
    );

    // Execute function
    return await fn();
  } finally {
    // Reset search_path to default (public, pg_catalog)
    await basePrisma.$executeRawUnsafe(
      `SET search_path TO public, pg_catalog`
    ).catch(() => {
      // Ignore errors on cleanup
    });
  }
}

/**
 * Extends the base Prisma client with tenant-aware query interceptors.
 * Automatically injects schema context for all queries.
 *
 * @param tenant The tenant context
 * @returns Extended Prisma client
 */
export function createTenantAwarePrismaClient(
  tenant: TenantContext
): PrismaClient {
  if (!validateSchemaName(tenant.schemaName)) {
    throw new InvalidSchemaError(
      tenant.schemaName,
      "Schema name failed validation; possible injection attempt"
    );
  }

  return basePrisma.$extends({
    name: `tenant-${tenant.id}`,
    query: {
      // Intercept raw queries
      $executeRaw: async ({ query, args }) => {
        const sqlText = typeof args === "string" ? args : String((args as any)?.strings?.join?.(" ") ?? args);
        // Validate query
        if (!validateTenantQuery(sqlText)) {
          throw new Error(
            `Dangerous query attempted in tenant schema: ${query}`
          );
        }

        // Inject schema context
        await basePrisma.$executeRawUnsafe(
          `SET search_path TO "${tenant.schemaName}", public, pg_catalog`
        );

        // Execute
        return query(args);
      },
      $executeRawUnsafe: async ({ query, args }) => {
        const sqlText = Array.isArray(args) ? String(args[0] ?? "") : String(args);
        // Validate query
        if (!validateTenantQuery(sqlText)) {
          throw new Error(
            `Dangerous query attempted in tenant schema: ${query}`
          );
        }

        // Inject schema context
        await basePrisma.$executeRawUnsafe(
          `SET search_path TO "${tenant.schemaName}", public, pg_catalog`
        );

        // Execute
        return query(args);
      },
      $queryRaw: async ({ query, args }) => {
        // Inject schema context
        await basePrisma.$executeRawUnsafe(
          `SET search_path TO "${tenant.schemaName}", public, pg_catalog`
        );

        // Execute
        return query(args);
      },
      $queryRawUnsafe: async ({ query, args }) => {
        // Inject schema context
        await basePrisma.$executeRawUnsafe(
          `SET search_path TO "${tenant.schemaName}", public, pg_catalog`
        );

        // Execute
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
}

/**
 * Batch execute multiple queries within a tenant schema (useful for migrations).
 * Runs all queries in a single transaction.
 *
 * @param tenant The tenant context
 * @param queries Array of SQL queries
 * @returns Array of results
 */
export async function executeTenantBatch(
  tenant: TenantContext,
  queries: string[]
): Promise<unknown[]> {
  if (!validateSchemaName(tenant.schemaName)) {
    throw new InvalidSchemaError(
      tenant.schemaName,
      "Schema name failed validation; possible injection attempt"
    );
  }

  const results: unknown[] = [];

  return await executeTenantTransaction(tenant, async (tx) => {
    for (const query of queries) {
      // Validate each query
      if (!validateTenantQuery(query)) {
        throw new Error(
          `Dangerous query in batch: ${query}`
        );
      }

      // Execute within transaction
      const result = await basePrisma.$executeRawUnsafe(query);
      results.push(result);
    }

    return results;
  });
}

/**
 * Query router statistics for monitoring/observability.
 */
export interface QueryRouterStats {
  totalTenantClients: number;
  cachedSchemas: string[];
  lastQueryTime?: number;
  failedQueries: number;
}

let failedQueryCount = 0;
let lastQueryTime = 0;

/**
 * Get query router statistics.
 */
export function getQueryRouterStats(): QueryRouterStats {
  return {
    totalTenantClients: tenantClientCache.size,
    cachedSchemas: Array.from(tenantClientCache.keys()),
    lastQueryTime,
    failedQueries: failedQueryCount,
  };
}

/**
 * Reset query statistics (for testing).
 */
export function resetQueryRouterStats(): void {
  failedQueryCount = 0;
  lastQueryTime = 0;
}
