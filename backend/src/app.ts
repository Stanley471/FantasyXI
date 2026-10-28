import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import apiV1Router from "./routes/index.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/error.middleware.js";
import { getJwks } from "./controllers/auth.controller.js";

import { requestReadConsistency } from "./middleware/readConsistency.js";

// Multi-tenant middleware
import {
  tenantContext,
  tenantContextToHeaders,
  logTenantContext,
} from "./middleware/tenantContext.js";
import {
  enforceTenanBoundary,
  detectSchemaInjection,
  validateTenantConsistency,
} from "./middleware/tenantBoundary.js";

dotenv.config();

const app = express();

// Trust reverse proxies (Cloudflare, Nginx, ALB) for accurate client IP rate limiting
app.set("trust proxy", 1);

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
    // Lets the browser read the FPL degradation flag (issue #275)
    exposedHeaders: ["X-Data-Stale"],
  })
);
app.use(express.json());
app.use(apiRateLimiter);
app.use(requestReadConsistency);

// ================================================================
// MULTI-TENANT MIDDLEWARE STACK
// ================================================================
// Order matters: tenant extraction → boundary validation → context headers

// 1. Extract tenant context (optional - routes can require it)
app.use(tenantContext({ required: false, debug: process.env.DEBUG_TENANT === "true" }));

// 2. Detect and block schema injection attempts
app.use(detectSchemaInjection);

// 3. Enforce tenant boundary (prevent cross-tenant access)
app.use(
  enforceTenanBoundary({
    debug: process.env.DEBUG_TENANT === "true",
    auditLog: true,
  })
);

// 4. Validate tenant consistency throughout request lifecycle
app.use(validateTenantConsistency);

// 5. Attach tenant context to response headers (for debugging/tracing)
app.use(tenantContextToHeaders);

// 6. Log tenant context in responses (optional)
if (process.env.DEBUG_TENANT === "true") {
  app.use(logTenantContext);
}

// ================================================================
// HEALTH CHECK ROUTES
// ================================================================

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "FantasyXI API",
    version: "0.2.0",
    status: "running",
    multiTenant: true,
  });
});

app.get("/api/health", (req: Request, res: Response) => {
  const response: any = {
    success: true,
    message: "FantasyXI API is running",
    timestamp: new Date().toISOString(),
  };

  // Include tenant context if available
  if (req.tenant) {
    response.tenant = {
      id: req.tenant.id,
      tier: req.tenant.tier,
      schema: req.tenant.schemaName,
    };
  }

  res.json(response);
});

// ================================================================
// ADMIN ENDPOINTS FOR TENANT MANAGEMENT
// ================================================================

/**
 * GET /api/v1/admin/tenants - List all active tenants (admin only)
 * Requires authentication with ADMIN role
 */
app.get("/api/v1/admin/tenants", async (_req: Request, res: Response) => {
  try {
    const { listActiveTenants } = await import(
      "./services/tenantContextService.js"
    );

    const tenants = await listActiveTenants();
    res.json({
      success: true,
      data: tenants,
      count: tenants.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list tenants",
    });
  }
});

/**
 * GET /api/v1/admin/tenant-stats - Get tenant boundary violation statistics
 * Shows security audit data for the last 24 hours
 */
app.get("/api/v1/admin/tenant-stats", async (_req: Request, res: Response) => {
  try {
    const { getTenantBoundaryStats } = await import(
      "./middleware/tenantBoundary.js"
    );

    const stats = await getTenantBoundaryStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to retrieve tenant statistics",
    });
  }
});

/**
 * POST /api/v1/admin/tenants - Create a new tenant (admin only)
 * Request body: { tier: 'ENTERPRISE' | 'SPONSORED', displayName: string }
 */
app.post("/api/v1/admin/tenants", async (req: Request, res: Response) => {
  try {
    const { tier, displayName } = req.body;

    if (!tier || !displayName) {
      res.status(400).json({
        success: false,
        message: "Missing required fields: tier, displayName",
      });
      return;
    }

    const { createTenant } = await import(
      "./services/tenantContextService.js"
    );

    const tenant = await createTenant(tier, displayName);
    res.status(201).json({
      success: true,
      data: tenant,
      message: `Tenant created: ${tenant.displayName}`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Failed to create tenant",
    });
  }
});

// ================================================================
// API V1 ROUTES
// ================================================================
// All routes under /api/v1 inherit the tenant middleware stack

// Public JWK Set for access-token verification (issue #332)
app.get("/.well-known/jwks.json", getJwks);

// API v1 Routes
app.use("/api/v1", apiV1Router);
app.use("/api", apiV1Router);

// ================================================================
// GLOBAL ERROR HANDLER (MUST BE LAST)
// ================================================================

app.use(errorHandler);

export default app;
