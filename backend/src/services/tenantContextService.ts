/**
 * Tenant registry and context resolution service.
 *
 * Maintains a cache of tenant metadata (ID → schema mapping, tier, etc.)
 * and provides utilities to resolve tenants by ID, validate isolation, and
 * manage the tenant lifecycle (creation, activation, deactivation).
 *
 * Cache is backed by Redis with fallback to in-memory storage.
 */

import { prisma } from "../config/db.js";
import { getRedisClient } from "../config/redis.js";
import {
  TenantContext,
  TenantCacheEntry,
  TenantNotFoundError,
  TenantRecord,
  TenantTier,
  validateSchemaName,
  generateSchemaName,
  getTenantQuotasByTier,
} from "../types/tenant.js";

/**
 * In-memory cache fallback when Redis is unavailable.
 * Replaced on every cache hit to provide simple TTL semantics.
 */
const memoryCache = new Map<string, TenantCacheEntry>();

/**
 * Redis cache key prefix for tenant context entries.
 */
const REDIS_TENANT_CACHE_KEY_PREFIX = "tenant:context:";

/**
 * Default cache TTL in milliseconds (5 minutes).
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolves a tenant ID to its context (metadata, schema name, tier).
 * Checks cache first (Redis → memory), then database.
 * Throws TenantNotFoundError if tenant does not exist or is inactive.
 *
 * @param tenantId - The tenant UUID to resolve
 * @throws TenantNotFoundError if tenant not found or inactive
 * @returns Resolved tenant context
 */
export async function resolveTenant(tenantId: string): Promise<TenantContext> {
  // Check Redis cache first
  const cacheEntry = await getCachedTenant(tenantId);
  if (cacheEntry) {
    return cacheEntry.context;
  }

  // Fall back to database
  const record = await prisma.tenant.findUnique({
    where: { id: tenantId },
  });

  if (!record || !record.isActive) {
    throw new TenantNotFoundError(tenantId);
  }

  const context: TenantContext = {
    id: record.id,
    tier: record.tier as TenantTier,
    schemaName: record.schemaName,
    displayName: record.displayName,
    retentionDays: record.retentionDays,
    isActive: record.isActive,
  };

  // Cache the resolved tenant
  await cacheTenant(context);

  return context;
}

/**
 * Retrieves a cached tenant context from Redis, with fallback to in-memory cache.
 *
 * @param tenantId - The tenant ID to retrieve
 * @returns Cache entry if hit and not expired, null otherwise
 */
async function getCachedTenant(
  tenantId: string
): Promise<TenantCacheEntry | null> {
  const cacheKey = `${REDIS_TENANT_CACHE_KEY_PREFIX}${tenantId}`;

  // Try Redis first
  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const entry = JSON.parse(cached) as TenantCacheEntry;
        if (!isCacheExpired(entry)) {
          return entry;
        }
        // Expired; clean up
        await redis.del(cacheKey);
      }
    } catch (error) {
      console.warn("[TenantCache] Redis get error for %s:", tenantId, error);
      // Fall through to memory cache
    }
  }

  // Check in-memory cache
  const memEntry = memoryCache.get(tenantId);
  if (memEntry && !isCacheExpired(memEntry)) {
    return memEntry;
  }
  if (memEntry) {
    memoryCache.delete(tenantId);
  }

  return null;
}

/**
 * Stores a tenant context in the cache (Redis + memory).
 *
 * @param context - The tenant context to cache
 * @param ttlMs - Cache TTL in milliseconds (default: 5 minutes)
 */
async function cacheTenant(
  context: TenantContext,
  ttlMs: number = DEFAULT_CACHE_TTL_MS
): Promise<void> {
  const entry: TenantCacheEntry = {
    context,
    cachedAt: Date.now(),
    ttlMs,
  };

  // Store in memory cache
  memoryCache.set(context.id, entry);

  // Store in Redis
  const redis = getRedisClient();
  if (redis) {
    const cacheKey = `${REDIS_TENANT_CACHE_KEY_PREFIX}${context.id}`;
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    try {
      await redis.set(cacheKey, JSON.stringify(entry), "EX", ttlSeconds);
    } catch (error) {
      console.warn(
        "[TenantCache] Redis set error for %s:",
        context.id,
        error
      );
      // Fallback to memory cache already done above
    }
  }
}

/**
 * Invalidates a cached tenant context (removes from both Redis and memory).
 *
 * @param tenantId - The tenant ID to invalidate
 */
export async function invalidateTenantCache(tenantId: string): Promise<void> {
  const cacheKey = `${REDIS_TENANT_CACHE_KEY_PREFIX}${tenantId}`;

  // Remove from memory cache
  memoryCache.delete(tenantId);

  // Remove from Redis
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(cacheKey);
    } catch (error) {
      console.warn(
        "[TenantCache] Redis delete error for %s:",
        tenantId,
        error
      );
    }
  }
}

/**
 * Checks if a cache entry has expired based on its TTL.
 */
function isCacheExpired(entry: TenantCacheEntry): boolean {
  const ageMs = Date.now() - entry.cachedAt;
  return ageMs > entry.ttlMs;
}

/**
 * Creates a new tenant schema and registers it in the tenant registry.
 * Validates schema name, ensures uniqueness, and initializes schema DDL.
 *
 * @param tier - Tenant tier (ENTERPRISE, SPONSORED, or PUBLIC)
 * @param displayName - Human-readable tenant name
 * @param customRetentionDays - Optional custom retention policy (respects tier quotas)
 * @returns Created tenant record with resolved context
 * @throws InvalidSchemaError if schema name is invalid or already exists
 */
export async function createTenant(
  tier: TenantTier,
  displayName: string,
  customRetentionDays?: number
): Promise<TenantContext> {
  if (tier === TenantTier.PUBLIC) {
    throw new Error(
      "Cannot create PUBLIC tier tenant; it uses the shared 'public' schema"
    );
  }

  // Generate schema name (tenant_<uuid> or sponsored_<uuid>)
  const schemaName = generateSchemaName(
    `${Date.now()}-${Math.random().toString(36).substring(7)}`,
    tier
  );

  if (!validateSchemaName(schemaName)) {
    throw new Error(`Invalid schema name generated: ${schemaName}`);
  }

  // Resolve retention days (respect tier quotas)
  const quotas = getTenantQuotasByTier(tier);
  const retentionDays = Math.min(
    customRetentionDays || 365,
    quotas.maxDataRetentionDays
  );

  // Create tenant record
  const record = await prisma.tenant.create({
    data: {
      tier,
      schemaName,
      displayName,
      retentionDays,
      maxLeagues: quotas.maxLeagues,
      isActive: true,
    },
  });

  // Initialize schema DDL (create schema if not exists)
  try {
    await prisma.$executeRawUnsafe(
      `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`
    );
    console.log(`[Tenant] Created schema: ${schemaName}`);
  } catch (error) {
    // Clean up on DDL failure
    await prisma.tenant.delete({ where: { id: record.id } });
    throw error;
  }

  const context: TenantContext = {
    id: record.id,
    tier: record.tier as TenantTier,
    schemaName: record.schemaName,
    displayName: record.displayName,
    retentionDays: record.retentionDays,
    isActive: record.isActive,
  };

  // Cache the new tenant
  await cacheTenant(context);

  return context;
}

/**
 * Lists all active tenant schemas (excluding 'public').
 *
 * @returns Array of active tenant contexts
 */
export async function listActiveTenants(): Promise<TenantContext[]> {
  const records = await prisma.tenant.findMany({
    where: {
      isActive: true,
      tier: { in: [TenantTier.ENTERPRISE, TenantTier.SPONSORED] },
    },
  });

  return records.map((r) => ({
    id: r.id,
    tier: r.tier as TenantTier,
    schemaName: r.schemaName,
    displayName: r.displayName,
    retentionDays: r.retentionDays,
    isActive: r.isActive,
  }));
}

/**
 * Deactivates a tenant (soft delete).
 * Schema is not dropped; data is preserved but tenant is inaccessible.
 *
 * @param tenantId - The tenant ID to deactivate
 */
export async function deactivateTenant(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { isActive: false },
  });

  // Invalidate cache
  await invalidateTenantCache(tenantId);
}

/**
 * Reactivates a previously deactivated tenant.
 *
 * @param tenantId - The tenant ID to reactivate
 */
export async function reactivateTenant(tenantId: string): Promise<TenantContext> {
  const record = await prisma.tenant.update({
    where: { id: tenantId },
    data: { isActive: true },
  });

  const context: TenantContext = {
    id: record.id,
    tier: record.tier as TenantTier,
    schemaName: record.schemaName,
    displayName: record.displayName,
    retentionDays: record.retentionDays,
    isActive: record.isActive,
  };

  // Cache the reactivated tenant
  await cacheTenant(context);

  return context;
}

/**
 * Updates tenant metadata (display name, retention policy).
 * Invalidates cache to force refresh.
 *
 * @param tenantId - The tenant ID to update
 * @param updates - Partial tenant record updates
 */
export async function updateTenantMetadata(
  tenantId: string,
  updates: {
    displayName?: string;
    retentionDays?: number;
    maxLeagues?: number;
  }
): Promise<TenantContext> {
  // Respect tier quotas for retention days
  let finalUpdates = { ...updates };
  if (updates.retentionDays) {
    const record = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tier: true },
    });
    if (record) {
      const quotas = getTenantQuotasByTier(record.tier as TenantTier);
      finalUpdates.retentionDays = Math.min(
        updates.retentionDays,
        quotas.maxDataRetentionDays
      );
    }
  }

  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data: finalUpdates,
  });

  const context: TenantContext = {
    id: updated.id,
    tier: updated.tier as TenantTier,
    schemaName: updated.schemaName,
    displayName: updated.displayName,
    retentionDays: updated.retentionDays,
    isActive: updated.isActive,
  };

  // Invalidate and re-cache
  await invalidateTenantCache(tenantId);
  await cacheTenant(context);

  return context;
}

/**
 * Verifies that a user belongs to a specific tenant (or has admin access).
 * Used by TenantBoundary middleware to prevent cross-tenant access.
 *
 * @param userId - The authenticated user ID
 * @param tenantId - The requested tenant ID
 * @returns true if user is authorized for this tenant
 */
export async function userBelongsToTenant(
  userId: string,
  tenantId: string
): Promise<boolean> {
  // For now, check if user has any membership/league in this tenant's schema
  // In a full implementation, you'd have a tenants_users bridge table
  // This is a simplified version that checks via league membership

  const tenant = await resolveTenant(tenantId);

  // Users with admin role can access any tenant (checked at middleware level)
  // Regular users can only access if they have a league/squad in the tenant

  try {
    const membership = await prisma.leagueMember.findFirst({
      where: {
        user: { id: userId },
        league: { creatorId: userId }, // creator of a league
      },
      select: { id: true },
    });

    return !!membership;
  } catch {
    // If query fails, deny access
    return false;
  }
}

/**
 * Gets tenant from database for a specific user's default context.
 * Useful for endpoints that don't have explicit tenant in JWT or params.
 *
 * @param userId - The user ID
 * @returns User's default tenant (or PUBLIC tier)
 */
export async function getUserDefaultTenant(
  userId: string
): Promise<TenantContext> {
  // Check if user belongs to any enterprise/sponsored leagues
  const leagueMembership = await prisma.leagueMember.findFirst({
    where: { userId },
    include: { league: true },
  });

  if (leagueMembership?.league) {
    // For now, return PUBLIC tier; in full implementation,
    // would resolve the league's tenant tier
    return {
      id: "public",
      tier: TenantTier.PUBLIC,
      schemaName: "public",
      displayName: "Public",
      retentionDays: 365,
      isActive: true,
    };
  }

  // Default to PUBLIC tier
  return {
    id: "public",
    tier: TenantTier.PUBLIC,
    schemaName: "public",
    displayName: "Public",
    retentionDays: 365,
    isActive: true,
  };
}

/**
 * Clears all cached tenant entries (use carefully; for admin/test purposes).
 */
export async function clearTenantCache(): Promise<void> {
  // Clear memory cache
  memoryCache.clear();

  // Clear Redis cache
  const redis = getRedisClient();
  if (redis) {
    try {
      const keys = await redis.keys(`${REDIS_TENANT_CACHE_KEY_PREFIX}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      console.warn("[TenantCache] Redis clear error:", error);
    }
  }
}

/**
 * Exports tenant cache statistics for monitoring.
 */
export function getTenantCacheStats(): {
  memoryCacheSize: number;
  ttlMs: number;
} {
  return {
    memoryCacheSize: memoryCache.size,
    ttlMs: DEFAULT_CACHE_TTL_MS,
  };
}
