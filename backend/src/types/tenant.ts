/**
 * Multi-tenant schema isolation types and interfaces.
 *
 * Defines tenant context, tier classifications, and schema routing metadata
 * for enterprise and sponsored league isolation.
 */

/**
 * Tenant tier classification.
 * Determines schema isolation strategy, retention policies, and resource quotas.
 */
export enum TenantTier {
  /** Public consumer league tier; uses shared 'public' schema */
  PUBLIC = "PUBLIC",
  /** Enterprise partnerships; isolated schema with dedicated retention policies */
  ENTERPRISE = "ENTERPRISE",
  /** Sponsored leagues; isolated schema with custom branding and compliance */
  SPONSORED = "SPONSORED",
}

/**
 * Tenant registration record (stored in public.tenants table).
 * Metadata about a tenant's schema, tier, and lifecycle settings.
 */
export interface TenantRecord {
  id: string;
  tier: TenantTier;
  schemaName: string;
  displayName: string;
  /** Data retention period in days (default 365) */
  retentionDays: number;
  /** Maximum leagues this tenant can create */
  maxLeagues: number;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

/**
 * Tenant context injected into Express Request after authentication.
 * Attached by tenantContext middleware; used to route queries to the correct schema.
 */
export interface TenantContext {
  /** Unique tenant identifier (UUID) */
  id: string;
  /** Tenant tier (PUBLIC, ENTERPRISE, SPONSORED) */
  tier: TenantTier;
  /** PostgreSQL schema name (e.g., "tenant_<id>", "sponsored_<id>", "public") */
  schemaName: string;
  /** Tenant display name for logging/audit */
  displayName: string;
  /** Data retention period in days */
  retentionDays: number;
  /** Whether tenant is currently active */
  isActive: boolean;
}

/**
 * Tenant context extracted from JWT claims or headers.
 * Can be either explicit (JWT claim) or implicit (derived from user's default tenant).
 */
export interface TenantClaimExtraction {
  /** Tenant ID from JWT 'tenant_id' claim or derived from user */
  tenantId: string;
  /** Source: 'jwt_claim', 'user_default', 'header', 'url_param' */
  source: "jwt_claim" | "user_default" | "header" | "url_param";
  /** Tenant context if available (cached) */
  context?: TenantContext;
}

/**
 * Tenant registry cache entry.
 * TTL-based cache for tenant metadata to avoid repeated lookups.
 */
export interface TenantCacheEntry {
  context: TenantContext;
  /** Timestamp when this entry was cached (milliseconds) */
  cachedAt: number;
  /** Cache TTL in milliseconds (default 5 minutes = 300000) */
  ttlMs: number;
}

/**
 * Dynamic Prisma client per tenant schema.
 * Wraps the base Prisma client with schema routing and query contextualization.
 */
export interface TenantPrismaClient {
  /** The tenant this client is bound to */
  tenant: TenantContext;
  /** Execute a raw query with schema context prepended */
  executeRaw: (query: string, params?: unknown[]) => Promise<unknown>;
  /** Execute a query and return rows */
  query: (query: string, params?: unknown[]) => Promise<unknown[]>;
  /** Execute a transaction scoped to tenant schema */
  transaction: (fn: (client: TenantPrismaClient) => Promise<any>) => Promise<any>;
}

/**
 * Schema validation error thrown when a schema name fails validation.
 */
export class InvalidSchemaError extends Error {
  constructor(schemaName: string, reason: string) {
    super(`Invalid schema name '${schemaName}': ${reason}`);
    this.name = "InvalidSchemaError";
  }
}

/**
 * Tenant not found error thrown when a tenant ID does not resolve to a schema.
 */
export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`Tenant '${tenantId}' not found or inactive`);
    this.name = "TenantNotFoundError";
  }
}

/**
 * Cross-tenant boundary violation detected.
 * Logged to audit table and request rejected.
 */
export class TenantBoundaryViolationError extends Error {
  constructor(
    public attemptedTenantId: string,
    public requestedTenantId: string,
    public reason: string
  ) {
    super(
      `Tenant boundary violation: user attempted access to '${attemptedTenantId}' but belongs to '${requestedTenantId}'. Reason: ${reason}`
    );
    this.name = "TenantBoundaryViolationError";
  }
}

/**
 * Audit log entry for tenant security events.
 */
export interface TenantSecurityAuditEntry {
  id: string;
  tenantId: string;
  userId?: string;
  attemptedSchema: string;
  violationType:
    | "cross_tenant_access_attempt"
    | "invalid_schema"
    | "unauthorized_tier_access"
    | "schema_injection_blocked";
  requestPath?: string;
  createdAt: Date;
}

/**
 * Migration status per tenant.
 */
export interface TenantMigrationStatus {
  tenantId: string;
  migrationName: string;
  appliedAt: Date;
  status: "success" | "failed" | "pending" | "rolled_back";
  errorMessage?: string;
}

/**
 * Migration dispatch result for multi-tenant migration runner.
 */
export interface MultiTenantMigrationResult {
  totalTenants: number;
  successfulTenants: number;
  failedTenants: number;
  migrations: {
    tenantId: string;
    schemaName: string;
    status: "success" | "failed";
    appliedAt: Date;
    error?: string;
  }[];
}

/**
 * Tenant bootstrap configuration.
 * Used when creating a new tenant schema and initializing its tables.
 */
export interface TenantBootstrapConfig {
  tenantId: string;
  tier: TenantTier;
  schemaName: string;
  displayName: string;
  retentionDays: number;
  maxLeagues: number;
}

/**
 * Query execution context for tenant-aware operations.
 * Ensures all queries are scoped to the tenant's schema.
 */
export interface TenantQueryContext {
  tenant: TenantContext;
  userId: string;
  requestId: string;
  /** High-resolution timestamp for query tracing */
  startTimeMs: number;
}

/**
 * Tenant resource limits and quotas.
 */
export interface TenantQuotas {
  maxLeagues: number;
  maxLeaguesActive: number;
  maxMembersPerLeague: number;
  maxDataRetentionDays: number;
  allowCustomBranding: boolean;
  allowCustomRetention: boolean;
}

/**
 * Resolve tenant quotas by tier.
 */
export function getTenantQuotasByTier(tier: TenantTier): TenantQuotas {
  switch (tier) {
    case TenantTier.ENTERPRISE:
      return {
        maxLeagues: 1000,
        maxLeaguesActive: 500,
        maxMembersPerLeague: 10000,
        maxDataRetentionDays: 2555, // 7 years
        allowCustomBranding: true,
        allowCustomRetention: true,
      };
    case TenantTier.SPONSORED:
      return {
        maxLeagues: 500,
        maxLeaguesActive: 250,
        maxMembersPerLeague: 5000,
        maxDataRetentionDays: 1825, // 5 years
        allowCustomBranding: true,
        allowCustomRetention: true,
      };
    case TenantTier.PUBLIC:
    default:
      return {
        maxLeagues: 100,
        maxLeaguesActive: 50,
        maxMembersPerLeague: 500,
        maxDataRetentionDays: 365,
        allowCustomBranding: false,
        allowCustomRetention: false,
      };
  }
}

/**
 * PostgreSQL schema name validation.
 * Prevents SQL injection and enforces naming conventions.
 */
export function validateSchemaName(schemaName: string): boolean {
  // Schema names must match pattern: public | tenant_<UUID> | sponsored_<UUID>
  const validPatterns = [
    /^public$/,
    /^tenant_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /^sponsored_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  ];
  return validPatterns.some((pattern) => pattern.test(schemaName));
}

/**
 * Generate a schema name from a tenant ID and tier.
 */
export function generateSchemaName(tenantId: string, tier: TenantTier): string {
  switch (tier) {
    case TenantTier.ENTERPRISE:
      return `tenant_${tenantId}`;
    case TenantTier.SPONSORED:
      return `sponsored_${tenantId}`;
    case TenantTier.PUBLIC:
    default:
      return "public";
  }
}
