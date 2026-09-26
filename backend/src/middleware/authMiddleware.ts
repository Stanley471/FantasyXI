import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { verifyAccessToken } from "../config/jwt.js";
import { prisma } from "../config/db.js";
import {
  Permission,
  Role,
  hasPermission,
  isElevatedPermission,
} from "../config/permissions.js";
import {
  SERVICE_KEY_HEADER,
  authenticateServiceKey,
} from "../config/serviceAuth.js";
import { AuthUser, UserRole } from "../types/index.js";

/**
 * Global declaration merging to extend Express Request with authenticated user.
 *
 * Laravel equivalent: The $request->user() helper available on Illuminate\Http\Request
 * once authenticated through auth:sanctum or auth:api.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Authentication middleware that requires a valid JWT Bearer token, or a
 * service API key in the X-Service-Key header for automated callers.
 * Rejects unauthenticated requests with HTTP 401.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const serviceKey = req.headers[SERVICE_KEY_HEADER];
  if (serviceKey !== undefined) {
    const service =
      typeof serviceKey === "string" ? authenticateServiceKey(serviceKey) : null;
    if (!service) {
      res.status(401).json({
        success: false,
        message: "Invalid service credentials.",
      });
      return;
    }

    req.user = {
      id: `service:${service.name}`,
      email: "",
      username: service.name,
      role: Role.SERVICE,
    };
    next();
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      success: false,
      message: "Authentication required. Missing Authorization header.",
    });
    return;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    res.status(401).json({
      success: false,
      message:
        "Authentication required. Malformed Authorization header. Expected Bearer <token>.",
    });
    return;
  }

  const token = parts[1];

  try {
    const payload = verifyAccessToken(token);

    if (!payload.userId) {
      res.status(401).json({
        success: false,
        message: "Invalid authentication token payload.",
      });
      return;
    }

    req.user = {
      id: payload.userId,
      email: payload.email || "",
      username: payload.username || "",
      role: asUserRole(payload.role),
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        message: "Token has expired",
      });
      return;
    }

    res.status(401).json({
      success: false,
      message: "Invalid authentication token",
    });
    return;
  }
}

/**
 * Coerces an arbitrary JWT role string into a known UserRole.
 * Unknown / missing roles fall back to USER for forward compatibility.
 * SERVICE is deliberately not accepted from a JWT: it is only granted to
 * callers presenting a service API key.
 */
function asUserRole(role: unknown): UserRole {
  switch (role) {
    case UserRole.ADMIN:
      return UserRole.ADMIN;
    case UserRole.MODERATOR:
      return UserRole.MODERATOR;
    default:
      return UserRole.USER;
  }
}

/**
 * Role-Based Access Control (RBAC) middleware factory.
 *
 * Returns a middleware that requires the authenticated user to hold at least
 * one of the supplied roles. Rejects insufficiently privileged requests with
 * HTTP 403. Must be mounted after `requireAuth`.
 */
export function requireRole(...allowedRoles: Role[]): (
  req: Request,
  res: Response,
  next: NextFunction
) => void {
  const permitted = new Set(allowedRoles);

  return function roleGuard(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
      return;
    }

    if (!permitted.has(req.user.role)) {
      res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action.",
      });
      return;
    }

    next();
  };
}

/**
 * Convenience guard restricting access to ADMIN / MODERATOR roles.
 */
export const requireStaff = requireRole(UserRole.ADMIN, UserRole.MODERATOR);

/** Looks up an account's current role; null when the account no longer exists. */
export type RoleResolver = (userId: string) => Promise<Role | null>;

const resolveRoleFromDatabase: RoleResolver = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return user ? user.role : null;
};

let defaultRoleResolver: RoleResolver = resolveRoleFromDatabase;

/**
 * Replaces the role lookup used by `requirePermission` (tests without a
 * database). Pass null to restore the database lookup.
 */
export function setRoleResolver(resolver: RoleResolver | null): void {
  defaultRoleResolver = resolver ?? resolveRoleFromDatabase;
}

/**
 * Builds the permission guard. The role resolver is injectable for tests;
 * without one, the current default resolver is used.
 */
export function createPermissionGuard(resolveRole?: RoleResolver) {
  /**
   * Permission-based RBAC middleware factory (see config/permissions.ts).
   *
   * Requires the authenticated principal to hold every listed permission;
   * responds 401 without a principal and 403 when a permission is missing.
   * For elevated permissions the role in the JWT is re-verified against the
   * database, so a demoted or deleted account loses access immediately.
   * Must be mounted after `requireAuth`.
   */
  return function requirePermission(...permissions: Permission[]) {
    const elevated = permissions.some(isElevatedPermission);

    return async function permissionGuard(
      req: Request,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const forbid = () => {
        res.status(403).json({
          success: false,
          message: "You do not have permission to perform this action.",
        });
      };

      if (!permissions.every((p) => hasPermission(req.user!.role, p))) {
        forbid();
        return;
      }

      if (elevated && req.user.role !== Role.SERVICE) {
        const currentRole = await (resolveRole ?? defaultRoleResolver)(req.user.id);
        if (!currentRole) {
          res.status(401).json({
            success: false,
            message: "Account no longer exists.",
          });
          return;
        }
        if (!permissions.every((p) => hasPermission(currentRole, p))) {
          forbid();
          return;
        }
        req.user.role = currentRole;
      }

      next();
    };
  };
}

export const requirePermission = createPermissionGuard();

/**
 * Optional authentication middleware.
 * Attaches req.user if a valid token is present, but allows unauthenticated requests through.
 */
export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return next();
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    try {
      const payload = verifyAccessToken(parts[1]);
      if (payload.userId) {
        req.user = {
          id: payload.userId,
          email: payload.email || "",
          username: payload.username || "",
          role: asUserRole(payload.role),
        };
      }
    } catch {
      // Ignore errors for optional authentication
    }
  }

  next();
}
