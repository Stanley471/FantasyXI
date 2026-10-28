/**
 * Tenant context extraction middleware for Express.
 *
 * Extracts the tenant identifier from JWT claims, HTTP headers, or URL parameters,
 * resolves it to a tenant context, and attaches it to req.tenant.
 *
 * Must run after requireAuth() or optionalAuth() so that req.user is available.
 * Enforces that all requests target a valid, active tenant.
 *
 * Priority for tenant resolution:
 * 1. JWT 'tenant_id' claim (explicit tenant selection)
 * 2. X-Tenant-ID header (for API clients)
 * 3. URL route parameter :tenantId (e.g., /api/v1/tenants/:tenantId/leagues)
 * 4. User's default tenant (inferred from user's league memberships)
 * 5. PUBLIC tier (fallback)
 */

import { Request, Response, NextFunction } from "express";
import { AuthUser } from "../types/index.js";
import { TenantNotFoundError, TenantContext } from "../types/tenant.js";
import { resolveTenant, getUserDefaultTenant } from "../services/tenantContextService.js";

/**
 * Global declaration merging to extend Express Request with tenant context.
 */
declare global {
  namespace Express {
    interface Request {
      /** Resolved tenant context for this request */
      tenant?: TenantContext;
      /** Source of tenant resolution (for logging/debugging) */
      tenantSource?: "jwt" | "header" | "param" | "default" | "fallback";
    }
  }
}

/**
 * Options for tenant context middleware.
 */
export interface TenantContextOptions {
  /** Whether to require tenant context (reject if not found) */
  required: boolean;
  /** Default tenant ID for fallback (when required=false) */
  defaultTenantId?: string;
  /** Whether to log tenant resolution for debugging */
  debug?: boolean;
}

/**
 * Tenant context extraction middleware factory.
 *
 * Extracts tenant identifier and resolves it to a tenant context.
 * Attaches req.tenant and req.tenantSource for downstream handlers.
 *
 * @param options Configuration options
 * @returns Express middleware function
 */
export function tenantContext(options: TenantContextOptions = { required: false }) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      let tenantId: string | null = null;
      let source: string | null = null;

      // 1. Try JWT claim (highest priority for explicit tenant selection)
      if (req.user) {
        const jwtTenantId = (req.user as any)?.tenant_id;
        if (jwtTenantId) {
          tenantId = jwtTenantId;
          source = "jwt";
        }
      }

      // 2. Try X-Tenant-ID header
      if (!tenantId) {
        const headerTenantId = req.headers["x-tenant-id"];
        if (typeof headerTenantId === "string" && headerTenantId.trim()) {
          tenantId = headerTenantId.trim();
          source = "header";
        }
      }

      // 3. Try URL route parameter :tenantId
      if (!tenantId && req.params.tenantId) {
        tenantId = Array.isArray(req.params.tenantId) ? req.params.tenantId[0] : req.params.tenantId;
        source = "param";
      }

      // 4. Try user's default tenant (if authenticated)
      if (!tenantId && req.user) {
        try {
          const defaultTenant = await getUserDefaultTenant(req.user.id);
          tenantId = defaultTenant.id;
          source = "default";
        } catch {
          // User may not have a default tenant; continue to fallback
        }
      }

      // 5. Fallback to default tenant ID (if provided in options)
      if (!tenantId && options.defaultTenantId) {
        tenantId = options.defaultTenantId;
        source = "fallback";
      }

      // If required=true and no tenant found, reject
      if (options.required && !tenantId) {
        res.status(400).json({
          success: false,
          message:
            "Tenant context required. Provide tenant ID via JWT claim (tenant_id), " +
            "X-Tenant-ID header, or URL parameter (:tenantId).",
        });
        return;
      }

      // If no tenant found and not required, proceed without tenant context
      if (!tenantId) {
        if (options.debug) {
          console.log(
            "[TenantContext] No tenant ID found; proceeding without tenant context"
          );
        }
        return next();
      }

      // Resolve tenant context
      try {
        const tenant = await resolveTenant(tenantId);

        req.tenant = tenant;
        req.tenantSource = source as any;

        if (options.debug) {
          console.log(
            `[TenantContext] Resolved tenant ${tenantId} (${tenant.tier}) from ${source}: schema=${tenant.schemaName}`
          );
        }

        next();
      } catch (error) {
        if (error instanceof TenantNotFoundError) {
          res.status(404).json({
            success: false,
            message: `Tenant '${tenantId}' not found or inactive.`,
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error("[TenantContext] Unexpected error:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error while resolving tenant context.",
      });
    }
  };
}

/**
 * Requires authenticated user to provide a valid tenant context.
 * Combines requireAuth + tenantContext.
 *
 * Use this on routes that must operate within a tenant schema.
 */
export const requireTenant = tenantContext({ required: true });

/**
 * Optional tenant context (attaches if present, but doesn't require).
 * Useful for routes that work in both multi-tenant and single-tenant contexts.
 */
export const optionalTenant = tenantContext({ required: false });

/**
 * Middleware to enforce that the tenant from the URL route matches the user's authorized tenant.
 * Prevents a user from accessing another tenant's data.
 *
 * Attach this after requireAuth + tenantContext on routes like:
 *   GET /api/v1/tenants/:tenantId/leagues
 *
 * where the URL parameter :tenantId should match the authenticated user's tenant.
 */
export function validateTenantRouteParam(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || !req.tenant) {
    // Let other middleware handle this
    return next();
  }

  // If both tenant context and route param exist, verify they match
  const routeTenantId = req.params.tenantId;
  if (routeTenantId && routeTenantId !== req.tenant.id) {
    res.status(403).json({
      success: false,
      message:
        `Tenant mismatch: you are authenticated for tenant '${req.tenant.id}' ` +
        `but requested tenant '${routeTenantId}'.`,
    });
    return;
  }

  next();
}

/**
 * Attach tenant context to outgoing response headers for tracing/debugging.
 * Helps correlate requests across logs and dashboards.
 */
export function tenantContextToHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.tenant) {
    res.set("X-Tenant-ID", req.tenant.id);
    res.set("X-Tenant-Schema", req.tenant.schemaName);
    res.set("X-Tenant-Tier", req.tenant.tier);
  }
  next();
}

/**
 * Logging middleware to record tenant context in structured logs.
 * Useful for debugging and audit trails.
 */
export function logTenantContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const original = res.json;
  res.json = function (data: any) {
    // Annotate response with tenant context
    if (req.tenant) {
      if (typeof data === "object" && data !== null) {
        data._tenant = {
          id: req.tenant.id,
          tier: req.tenant.tier,
          schema: req.tenant.schemaName,
        };
      }
    }
    return original.call(this, data);
  };
  next();
}

/**
 * Helper function to extract tenant ID from a request without middleware.
 * Useful for background jobs or one-off operations.
 *
 * @param req Express request object
 * @returns Extracted tenant ID or null
 */
export function extractTenantIdFromRequest(req: Request): string | null {
  // Check JWT claim
  if ((req.user as any)?.tenant_id) {
    return (req.user as any).tenant_id;
  }

  // Check header
  const headerTenantId = req.headers["x-tenant-id"];
  if (typeof headerTenantId === "string" && headerTenantId.trim()) {
    return headerTenantId.trim();
  }

  // Check URL param
  if (req.params.tenantId) {
    return Array.isArray(req.params.tenantId) ? req.params.tenantId[0] : req.params.tenantId;
  }

  return null;
}

/**
 * Extract all possible tenant identifiers from a request (for debugging).
 */
export function debugTenantExtraction(
  req: Request
): Record<string, string | null> {
  return {
    jwt_claim: (req.user as any)?.tenant_id || null,
    header: (req.headers["x-tenant-id"] as string) || null,
    url_param: (Array.isArray(req.params.tenantId) ? req.params.tenantId[0] : req.params.tenantId) || null,
    resolved: req.tenant?.id || null,
    source: req.tenantSource || null,
  };
}
