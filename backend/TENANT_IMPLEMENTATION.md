# Multi-Tenant PostgreSQL Schema Isolation - Implementation Guide

## Quick Start

### 1. Enable Multi-Tenant Mode

Add to `.env`:
```
DEBUG_TENANT=true  # Set to false in production
```

### 2. Initialize Tenant Infrastructure

```bash
# Step 1: Run migrations on public schema
npm run db:migrate

# Step 2: Bootstrap tenant system
npm run db:bootstrap-tenant

# Step 3: Create your first tenant
curl -X POST http://localhost:3000/api/v1/admin/tenants \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"tier": "ENTERPRISE", "displayName": "My Company"}'

# Step 4: Apply migrations to tenant
npm run db:migrate:tenants

# Step 5: Run tests
npm run test:tenants
```

---

## Architecture Overview

### Tenant Resolution Flow

```
HTTP Request
    ↓
Extract Tenant from:
  1. JWT claim (tenant_id)
  2. X-Tenant-ID header
  3. URL parameter (:tenantId)
  4. User's default tenant
  5. PUBLIC tier (fallback)
    ↓
Resolve tenant → TenantContext
    ↓
Set PostgreSQL search_path
    ↓
Execute query in tenant schema
    ↓
Response with tenant context headers
```

### Schema Isolation Model

```
Public Schema (shared)
├── users (global)
├── teams (global - FPL teams)
├── players (global - FPL players)
├── tenants (registry)
├── tenant_security_audits
└── tenant_migrations

Tenant Schema (isolated)
├── tenant_abc123
│   ├── leagues (tenant-specific)
│   ├── league_members
│   ├── squads
│   └── [all other tables]
├── tenant_def456
│   ├── leagues
│   ├── league_members
│   ├── squads
│   └── [all other tables]
└── sponsored_xyz789
    ├── leagues
    ├── league_members
    └── [all other tables]
```

### Middleware Stack

Executed in order:
1. `tenantContext` - Extract & resolve tenant
2. `detectSchemaInjection` - Block SQL injection attempts
3. `enforceTenanBoundary` - Authorization check
4. `validateTenantConsistency` - Mid-request mutation detection
5. `tenantContextToHeaders` - Attach trace headers
6. `logTenantContext` - Structured logging

---

## Using Multi-Tenant Context

### In Route Handlers

```typescript
// Optional tenant context (any request)
app.get("/api/v1/leagues", optionalTenant, async (req, res) => {
  if (req.tenant) {
    console.log(`Querying leagues in schema: ${req.tenant.schemaName}`);
  }
  res.json({ data: [] });
});

// Required tenant context (request will fail without it)
app.get("/api/v1/enterprise/settings", requireTenant, async (req, res) => {
  const tenant = req.tenant!;  // Guaranteed to exist
  res.json({ tenant_id: tenant.id, tier: tenant.tier });
});

// Tenant-tier restricted routes
app.get(
  "/api/v1/enterprise/advanced-features",
  requireTenant,
  requireTenantTier("ENTERPRISE"),
  async (req, res) => {
    // Only ENTERPRISE tenants can access
    res.json({ feature: "available" });
  }
);
```

### In Services

```typescript
import { resolveTenant } from "./services/tenantContextService.js";
import { executeTenantQuery } from "./services/dynamicQueryRouter.js";

export async function getLeaguesByTenant(tenantId: string) {
  const tenant = await resolveTenant(tenantId);
  
  const leagues = await executeTenantQuery(
    tenant,
    "SELECT * FROM leagues WHERE is_active = true",
    []
  );
  
  return leagues;
}

// Or use transaction for writes
export async function createLeague(tenantId: string, data: any) {
  const tenant = await resolveTenant(tenantId);
  
  const result = await executeTenantTransaction(tenant, async (_tx) => {
    // _tx is the transaction context
    // All queries automatically use tenant schema
    const league = await prisma.league.create({ data });
    return league;
  });
  
  return result;
}
```

### Tenant Context in JWT

The tenant can be included in JWT claims:

```typescript
// During token generation
const token = jwt.sign({
  userId: user.id,
  email: user.email,
  tenant_id: user.defaultTenantId,  // Optional
  role: user.role,
}, secret);

// Token is validated by tenantContext middleware
// Tenant extracted from token if present
```

### Tenant Context in Headers

```bash
# Request with X-Tenant-ID header
curl http://localhost:3000/api/v1/leagues \
  -H "X-Tenant-ID: tenant_abc123"

# Response includes tenant trace headers:
# X-Tenant-ID: tenant_abc123
# X-Tenant-Schema: tenant_abc123
# X-Tenant-Tier: ENTERPRISE
```

### Tenant Context in URL

```bash
# Route parameter :tenantId is extracted
GET /api/v1/tenants/:tenantId/leagues
GET /api/v1/tenants/tenant_abc123/leagues

# Tenant extracted from URL and validated
```

---

## Security Considerations

### Cross-Tenant Access Prevention

The system automatically prevents:
- **Query escape**: Attempting to use a different schema in a query
- **JWT manipulation**: Invalid tenant claims are rejected
- **SQL injection**: Schema injection attempts are blocked
- **Authorization bypass**: User must belong to the tenant (admin exempt)

### What's Audited

All security violations are logged to `tenant_security_audits`:

```sql
SELECT * FROM public.tenant_security_audits
WHERE violation_type IN (
  'cross_tenant_access_attempt',
  'schema_injection_blocked',
  'invalid_schema',
  'unauthorized_tier_access'
)
ORDER BY created_at DESC
LIMIT 20;
```

### Admin Bypass

ADMIN role users can access any tenant:

```typescript
if (req.user.role === UserRole.ADMIN) {
  // Can access any tenant, all boundary checks skipped
  next();
}
```

### Schema Name Validation

Only these patterns are allowed:
- `public`
- `tenant_<uuid>`
- `sponsored_<uuid>`

All other schema names are rejected.

---

## Migration Management

### Creating Migrations

```bash
# Create a new migration in Prisma
npm run db:migrate

# This creates a file in prisma/migrations/<timestamp>_<name>/migration.sql
```

### Applying Migrations

#### Local Development (single schema)
```bash
# Applies migration to public schema only
npm run db:migrate
```

#### Production (all tenants)
```bash
# Applies migration to all active tenant schemas
npm run db:migrate:tenants

# Check status
npm run db:migrate:tenants:status

# Retry failed migrations
npm run db:migrate:tenants:retry
```

### Migration Tracking

Migrations are tracked per tenant in `tenant_migrations`:

```sql
SELECT
  tenant_id,
  migration_name,
  status,
  applied_at,
  error_message
FROM public.tenant_migrations
ORDER BY applied_at DESC
LIMIT 50;
```

### Rollback (Manual)

Rollback is not automatic. To rollback a migration:

```bash
# 1. Create revert migration
# prisma/migrations/<timestamp>_<name>/revert.sql

# 2. Execute revert manually per tenant
psql -c "
SET search_path TO tenant_abc123, public, pg_catalog;
-- paste revert.sql content
"

# 3. Mark as rolled back in tracking table
psql -c "
UPDATE public.tenant_migrations
SET status = 'rolled_back'
WHERE tenant_id = 'abc123-...' AND migration_name = '...'
"
```

---

## Caching Strategy

### Redis Cache (Recommended)

Tenant contexts are cached in Redis with 5-minute TTL:

```
Key: tenant:context:<tenant_id>
Value: { id, tier, schemaName, displayName, retentionDays, isActive }
TTL: 300 seconds
```

Cache is invalidated automatically when:
- Tenant metadata is updated
- Tenant is deactivated
- `npm run db:migrate:tenants` completes

### Memory Cache Fallback

If Redis is unavailable, in-memory cache is used:

```typescript
// Automatically managed by tenantContextService.ts
// Provides same 5-minute TTL
// Only stores ~100 entries by default
```

### Cache Debugging

```bash
# Check Redis cache
redis-cli KEYS "tenant:context:*"

# View cache entry
redis-cli GET "tenant:context:tenant_abc123"

# Clear cache (testing only)
redis-cli FLUSHDB
```

---

## Testing

### Tenant Isolation Tests

```bash
npm run test:tenants

# Tests cover:
# - Schema name validation & injection prevention
# - Tenant context resolution & caching
# - Cross-tenant access prevention
# - Boundary violation auditing
# - Tier-based quotas
# - Data isolation verification
# - Error handling
# - Migration tracking
# - Transaction isolation
# - Concurrent operations
```

### Custom Tests

```typescript
import { describe, it } from "node:test";
import { resolveTenant, createTenant } from "../services/tenantContextService.js";

describe("My Tenant Feature", () => {
  it("should isolate data per tenant", async () => {
    const tenant1 = await createTenant("ENTERPRISE", "Tenant 1");
    const tenant2 = await createTenant("ENTERPRISE", "Tenant 2");
    
    // Verify they have different schemas
    assert.notStrictEqual(tenant1.schemaName, tenant2.schemaName);
  });
});
```

---

## Monitoring & Observability

### Environment Variables for Debugging

```bash
# Enable verbose tenant logging
DEBUG_TENANT=true

# Node log level
NODE_ENV=development

# Redis logging
REDIS_LOG_LEVEL=debug
```

### Observability Endpoints

```bash
# List all tenants
GET /api/v1/admin/tenants
Authorization: Bearer <ADMIN_TOKEN>

# Get security statistics (last 24 hours)
GET /api/v1/admin/tenant-stats
Authorization: Bearer <ADMIN_TOKEN>

# Create new tenant
POST /api/v1/admin/tenants
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
{
  "tier": "ENTERPRISE",
  "displayName": "Company Name"
}
```

### Logging Structure

Tenant context is automatically included in logs:

```json
{
  "level": "info",
  "msg": "GET /api/v1/leagues",
  "tenant_id": "tenant_abc123",
  "tenant_tier": "ENTERPRISE",
  "tenant_schema": "tenant_abc123",
  "user_id": "user_123",
  "duration_ms": 45
}
```

---

## Troubleshooting

### Tenant Not Resolving

```bash
# 1. Check if tenant exists
psql -c "SELECT * FROM public.tenants WHERE id = 'tenant_abc123';"

# 2. Verify tenant is active
psql -c "SELECT is_active FROM public.tenants WHERE id = 'tenant_abc123';"

# 3. Check cache
redis-cli GET "tenant:context:tenant_abc123"

# 4. Clear cache and retry
redis-cli DEL "tenant:context:tenant_abc123"

# 5. Enable debug logging
DEBUG_TENANT=true npm start
```

### Cross-Tenant Access Blocked Unexpectedly

```bash
# 1. Check tenant audit log
psql -c "
SELECT * FROM public.tenant_security_audits
WHERE user_id = 'user_123'
ORDER BY created_at DESC LIMIT 10;
"

# 2. Verify user belongs to tenant
psql -c "
SELECT * FROM public.league_members
WHERE user_id = 'user_123' AND league_id IN (
  SELECT id FROM public.leagues
)
LIMIT 5;
"

# 3. Check JWT claims
# Decode JWT and verify tenant_id matches requested tenant
```

### Migration Stuck or Timing Out

```bash
# 1. Check for blocking queries
psql -c "
SELECT pid, usename, query, query_start
FROM pg_stat_activity
WHERE state = 'active'
ORDER BY query_start DESC;
"

# 2. Kill stuck query if necessary
psql -c "SELECT pg_terminate_backend(<pid>);"

# 3. Retry migration
npm run db:migrate:tenants:retry
```

---

## Best Practices

### 1. Always Use Tenant Context in Multi-Tenant Routes

```typescript
// ✓ Good: Tenant is required
app.get("/api/v1/enterprise/leagues", requireTenant, async (req, res) => {
  const leagues = await getLeaguesByTenant(req.tenant!.id);
  res.json(leagues);
});

// ✗ Bad: Tenant context not enforced
app.get("/api/v1/leagues", async (req, res) => {
  // Could leak data across tenants!
  res.json(await getAllLeagues());
});
```

### 2. Validate Tenant Ownership Before Operations

```typescript
// ✓ Good: Verify user belongs to tenant
const tenant = await resolveTenant(tenantId);
const isMember = await userBelongsToTenant(userId, tenantId);
if (!isMember && user.role !== UserRole.ADMIN) {
  throw new ForbiddenError("Not a member of this tenant");
}

// ✗ Bad: Trust tenant_id from client
const tenant = await resolveTenant(req.body.tenantId);
// User could claim membership in any tenant!
```

### 3. Use Transactions for Multi-Step Operations

```typescript
// ✓ Good: Atomic within tenant
await executeTenantTransaction(tenant, async (_tx) => {
  const league = await prisma.league.create(data);
  await prisma.leagueMember.create(memberData);
  // All-or-nothing: both succeed or both fail
});

// ✗ Bad: Individual queries can partially succeed
await prisma.league.create(data);
await prisma.leagueMember.create(memberData);
// Second could fail, leaving orphaned league
```

### 4. Plan Migrations Early

```typescript
// ✓ Good: Test on all tenants before deployment
npm run db:migrate:tenants:status  # Check
npm run db:migrate:tenants         # Apply
npm run test:tenants               # Verify

// ✗ Bad: Deploy without testing
npm run build && npm start
// Migration might fail on some tenants, leaving them corrupted
```

### 5. Monitor Audit Log Regularly

```bash
# Daily check
psql -c "
SELECT violation_type, COUNT(*) as count
FROM public.tenant_security_audits
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY violation_type;
"
```

---

## File Reference

| File | Purpose |
|------|---------|
| `src/types/tenant.ts` | Type definitions & utilities |
| `src/services/tenantContextService.ts` | Tenant registry & caching |
| `src/middleware/tenantContext.ts` | Tenant extraction middleware |
| `src/middleware/tenantBoundary.ts` | Isolation enforcement |
| `src/services/dynamicQueryRouter.ts` | Schema-aware query execution |
| `src/scripts/multiTenantMigration.ts` | Migration runner |
| `src/tests/tenantIsolation.test.ts` | Isolation tests (50+ cases) |
| `src/tests/multiTenantMigration.test.ts` | Migration tests (40+ cases) |
| `prisma/sql/tenant_bootstrap.sql` | Database setup & helpers |
| `prisma/sql/tenant_schema_init.sql` | Schema initialization template |
| `TENANT_IMPLEMENTATION.md` | This file |

---

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review test cases for working examples
3. Check debug logs: `DEBUG_TENANT=true npm start`
4. Contact database team for infrastructure issues

---

**Last Updated**: October 2024  
**Maintained By**: DevOps & Database Teams
