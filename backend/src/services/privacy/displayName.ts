/**
 * Public display names for leaderboard anonymization (issue #511).
 *
 * Privacy-conscious managers can turn on the anonymity toggle in settings.
 * When enabled, every public standings serializer shows a deterministic
 * alias ("Manager #XXXX") instead of the manager's username, while the
 * manager themselves and platform admins keep seeing the real username.
 *
 * The alias is derived from the stable user id (FNV-1a hash), never from a
 * random draw, so the same manager always shows the same alias in every
 * public view. The alias carries no personal information and cannot be
 * reversed into a username without the user id.
 */

export interface PrivacyViewer {
  id?: string;
  /** UserRole string ("USER" | "MODERATOR" | "ADMIN") or the SERVICE principal. */
  role?: string | null;
}

export interface PublicNameOwner {
  id: string;
  username: string;
  isAnonymous?: boolean | null;
}

/** Alias numbers run from 1000 to 9999 so the display is always 4 digits. */
const ALIAS_MIN = 1000;
const ALIAS_RANGE = 9000;

/**
 * FNV-1a 32-bit hash of the user id, folded into the 1000–9999 alias range.
 * Deterministic per user id; collisions only merge two anonymous managers
 * under one alias, which reveals nothing about either of them.
 */
export function managerAliasForUserId(userId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const number = ALIAS_MIN + ((hash >>> 0) % ALIAS_RANGE);
  return `Manager #${number}`;
}

/** Only ADMIN counts as a platform admin; moderators see public views. */
export function isPlatformAdmin(role?: string | null): boolean {
  return role === "ADMIN";
}

/**
 * Whether this viewer may see the owner's real username: the owner
 * themselves, or a platform admin. Everyone else (including signed-out
 * viewers) sees the public form.
 */
export function canSeeRealName(ownerId: string, viewer?: PrivacyViewer | null): boolean {
  if (!viewer) return false;
  if (viewer.id !== undefined && viewer.id === ownerId) return true;
  return isPlatformAdmin(viewer.role);
}

/**
 * The username to show for a manager in a public view: the real username
 * for the owner themselves and platform admins, the deterministic alias
 * when the manager opted into anonymity, and the real username otherwise.
 */
export function displayUsername(owner: PublicNameOwner, viewer?: PrivacyViewer | null): string {
  if (!owner.isAnonymous) return owner.username;
  if (canSeeRealName(owner.id, viewer)) return owner.username;
  return managerAliasForUserId(owner.id);
}

/**
 * Normalizes the viewer argument services accept: a bare user id (legacy
 * callers that only know who is viewing) or a full viewer object carrying
 * the role. A bare id can prove "self" but never admin.
 */
export function normalizeViewer(viewer?: string | PrivacyViewer | null): PrivacyViewer | undefined {
  if (viewer === undefined || viewer === null) return undefined;
  if (typeof viewer === "string") return { id: viewer };
  return viewer;
}
