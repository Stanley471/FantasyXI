import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { verifyAccessToken } from "../config/jwt.js";
import { AuthUser, UserRole } from "../types/index.js";
import { setRlsContext } from "../config/db.js";

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
 * Authentication middleware that requires a valid JWT Bearer token.
 * Rejects unauthenticated requests with HTTP 401.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
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

    // Set PostgreSQL RLS context for multi-tenant data isolation
    setRlsContext(payload.userId).catch(() => {
      // RLS may not be enabled in all environments; fail silently
    });

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
export function requireRole(...allowedRoles: UserRole[]): (
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
        setRlsContext(payload.userId).catch(() => {});
      }
    } catch {
      // Ignore errors for optional authentication
    }
  }

  next();
}
