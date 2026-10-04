/**
 * Per-user offline snapshots kept in localStorage so a manager can still open
 * their profile and squad with no connection.
 *
 * Authenticated API responses are deliberately NOT cached by the service
 * worker (its cache is shared by everyone using the browser); this store is
 * keyed by user and cleared on sign-out instead.
 */
import { ApiError } from "@/lib/api";
import { Squad, User } from "@/types";

const USER_KEY = "fxi:offline:user";
const SQUADS_KEY_PREFIX = "fxi:offline:squads:";

export interface SquadSnapshot {
  savedAt: string;
  squads: Squad[];
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable (private mode): offline viewing just degrades
  }
}

export function saveOfflineUser(user: User): void {
  write(USER_KEY, user);
}

export function loadOfflineUser(): User | null {
  return read<User>(USER_KEY);
}

export function saveSquadSnapshot(userId: string, squads: Squad[]): void {
  write(`${SQUADS_KEY_PREFIX}${userId}`, { savedAt: new Date().toISOString(), squads });
}

export function loadSquadSnapshot(userId: string): SquadSnapshot | null {
  return read<SquadSnapshot>(`${SQUADS_KEY_PREFIX}${userId}`);
}

/** Removes every offline snapshot (called on sign-out). */
export function clearOfflineData(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key === USER_KEY || key?.startsWith(SQUADS_KEY_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Nothing to clear
  }
}

/**
 * True when a request failed because the network (or API) is unreachable,
 * as opposed to the server rejecting it. fetch() rejects with a TypeError on
 * network failure; the service worker answers uncached API calls with a 503
 * flagged `offline: true`.
 */
export function isOfflineError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (error instanceof TypeError) return true;
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    Boolean((error.data as { offline?: boolean } | undefined)?.offline)
  );
}
