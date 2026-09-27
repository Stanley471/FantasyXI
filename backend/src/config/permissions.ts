import { UserRole } from "@prisma/client";

/**
 * Role-Based Access Control (RBAC) policy.
 *
 * Every protected backend capability is expressed as a Permission, and every
 * role is granted an explicit set of permissions. Routes declare the
 * permission they need (see `requirePermission`) instead of hard-coding role
 * lists, so this file is the single source of truth for who can do what.
 *
 * Laravel equivalent: Gate::define() abilities in AuthServiceProvider, or a
 * spatie/laravel-permission role => permission seeder.
 */

/**
 * Principal roles. USER / MODERATOR / ADMIN are stored on user accounts.
 * SERVICE is never stored in the database: it is only granted to automated
 * callers (cron jobs, workers, monitoring) that authenticate with a service
 * API key, and it cannot be carried by a user JWT.
 */
export const Role = {
  USER: UserRole.USER,
  MODERATOR: UserRole.MODERATOR,
  ADMIN: UserRole.ADMIN,
  SERVICE: "SERVICE",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export enum Permission {
  // Own account
  PROFILE_READ = "profile:read",
  /** Account settings: sign-in methods, password */
  PROFILE_UPDATE_OWN = "profile:update:own",

  // Squads (ownership is enforced additionally by the squad service)
  SQUAD_CREATE = "squad:create",
  SQUAD_UPDATE_OWN = "squad:update:own",
  SQUAD_READ_OWN = "squad:read:own",

  // Leagues (creator-only rules are enforced additionally by the league service)
  LEAGUE_CREATE = "league:create",
  LEAGUE_JOIN = "league:join",
  LEAGUE_CANCEL_OWN = "league:cancel:own",
  /** Creator-only league administration such as private invitations */
  LEAGUE_MANAGE_OWN = "league:manage:own",

  // Entry-fee payments and financial views scoped to the caller
  PAYMENT_MANAGE_OWN = "payment:manage:own",
  SETTLEMENT_READ = "settlement:read",
  AFFILIATE_READ_OWN = "affiliate:read:own",

  // Operations
  FPL_SYNC = "fpl:sync",
  SCORE_CALCULATE = "score:calculate",
  FINANCIAL_RECONCILE = "financial:reconcile",
  SYSTEM_HEALTH_READ = "system:health:read",

  // Payout dead-letter queue and financial audit log
  PAYOUT_READ = "payout:read",
  PAYOUT_MANAGE = "payout:manage",
  FINANCIAL_AUDIT_READ = "financial:audit:read",
}

/** Everything a signed-in manager can do with their own data. */
const USER_PERMISSIONS: readonly Permission[] = [
  Permission.PROFILE_READ,
  Permission.PROFILE_UPDATE_OWN,
  Permission.SQUAD_CREATE,
  Permission.SQUAD_UPDATE_OWN,
  Permission.SQUAD_READ_OWN,
  Permission.LEAGUE_CREATE,
  Permission.LEAGUE_JOIN,
  Permission.LEAGUE_CANCEL_OWN,
  Permission.LEAGUE_MANAGE_OWN,
  Permission.PAYMENT_MANAGE_OWN,
  Permission.SETTLEMENT_READ,
  Permission.AFFILIATE_READ_OWN,
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  [Role.USER]: new Set(USER_PERMISSIONS),
  [Role.MODERATOR]: new Set([
    ...USER_PERMISSIONS,
    Permission.FPL_SYNC,
    Permission.FINANCIAL_RECONCILE,
    Permission.SYSTEM_HEALTH_READ,
    Permission.PAYOUT_READ,
  ]),
  [Role.ADMIN]: new Set([
    ...USER_PERMISSIONS,
    Permission.FPL_SYNC,
    Permission.SCORE_CALCULATE,
    Permission.FINANCIAL_RECONCILE,
    Permission.SYSTEM_HEALTH_READ,
    Permission.PAYOUT_READ,
    // Moving or writing off funds and reading every user's ledger stay ADMIN-only
    Permission.PAYOUT_MANAGE,
    Permission.FINANCIAL_AUDIT_READ,
  ]),
  // Automated callers act on platform data, never as a manager
  [Role.SERVICE]: new Set([
    Permission.FPL_SYNC,
    Permission.SCORE_CALCULATE,
    Permission.FINANCIAL_RECONCILE,
    Permission.SYSTEM_HEALTH_READ,
  ]),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Permissions a regular USER does not hold. Requests needing one of these
 * have their role re-verified against the database, so demoting an account
 * takes effect immediately rather than when its JWT expires.
 */
export function isElevatedPermission(permission: Permission): boolean {
  return !ROLE_PERMISSIONS[Role.USER].has(permission);
}
