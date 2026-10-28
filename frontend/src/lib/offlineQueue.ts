/**
 * offlineQueue.ts — FantasyXI Issue #214
 *
 * Offline Squad Mutation Queue backed by IndexedDB with Background Sync
 * support via Service Worker. Persists lineup changes when offline and
 * syncs them when network connectivity is restored.
 *
 * Issue #334 adds causal ordering (a persisted, monotonically increasing
 * `seq`), cross-tab mutual exclusion (Web Locks API) and deterministic
 * conflict resolution: transient failures stop the flush so later mutations
 * never overtake earlier ones, while server rejections (deadline passed,
 * invalid formation) are dropped and reported so the UI can roll back.
 */

import { api, ApiError } from "@/lib/api";
import { isOfflineError } from "@/lib/offlineStore";

export const DB_NAME = "fantasyxi-offline-queue";
export const DB_VERSION = 1;
export const STORE_NAME = "squad_mutations";
export const SYNC_TAG = "sync-squad-mutations";
export const MAX_QUEUE_RETRIES = 5;
/** Short critical sections that read-modify-write queue entries. */
const QUEUE_LOCK = "fantasyxi-offline-queue";
/** Held for a whole flush, so only one tab replays the queue at a time. */
const FLUSH_LOCK = "fantasyxi-offline-flush";

export interface SquadPlayerMutation {
  playerId: number;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number;
}

export interface SquadMutationPayload {
  name: string;
  players: SquadPlayerMutation[];
  userId?: string;
}

export interface QueuedSquadMutation {
  id: string;
  squadId?: number | string | null;
  userId?: string | null;
  action: "update" | "create";
  payload: SquadMutationPayload;
  timestamp: number;
  /** Causal position: replay order, persisted so it survives reloads (issue #334). */
  seq?: number;
  retryCount: number;
  status: "pending" | "syncing" | "failed" | "conflict";
  lastError?: string;
  baseRevision?: string;
  serverRevision?: string;
}

export interface OfflineQueueStorage {
  getAll(): Promise<QueuedSquadMutation[]>;
  get(id: string): Promise<QueuedSquadMutation | undefined>;
  put(mutation: QueuedSquadMutation): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Replay order: by causal sequence, entries from before #334 (no seq) first by time. */
export function compareCausalOrder(a: QueuedSquadMutation, b: QueuedSquadMutation): number {
  return (a.seq ?? 0) - (b.seq ?? 0) || a.timestamp - b.timestamp;
}

// In-memory fallback / testing storage
export class MemoryQueueStorage implements OfflineQueueStorage {
  private store = new Map<string, QueuedSquadMutation>();

  async getAll(): Promise<QueuedSquadMutation[]> {
    return Array.from(this.store.values()).sort(compareCausalOrder);
  }

  async get(id: string): Promise<QueuedSquadMutation | undefined> {
    const item = this.store.get(id);
    return item ? JSON.parse(JSON.stringify(item)) : undefined;
  }

  async put(mutation: QueuedSquadMutation): Promise<void> {
    this.store.set(mutation.id, JSON.parse(JSON.stringify(mutation)));
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

// IndexedDB storage implementation
export class IndexedDBQueueStorage implements OfflineQueueStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not supported in this environment"));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("by_squadId", "squadId", { unique: false });
          store.createIndex("by_status", "status", { unique: false });
          store.createIndex("by_timestamp", "timestamp", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  async getAll(): Promise<QueuedSquadMutation[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const results = (req.result as QueuedSquadMutation[]) || [];
        results.sort(compareCausalOrder);
        resolve(results);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async get(id: string): Promise<QueuedSquadMutation | undefined> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(mutation: QueuedSquadMutation): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(mutation);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

let activeStorage: OfflineQueueStorage | null = null;

export function getQueueStorage(): OfflineQueueStorage {
  if (activeStorage) return activeStorage;
  if (typeof indexedDB !== "undefined") {
    activeStorage = new IndexedDBQueueStorage();
  } else {
    activeStorage = new MemoryQueueStorage();
  }
  return activeStorage;
}

export function setCustomStorageForTest(storage: OfflineQueueStorage | null): void {
  activeStorage = storage;
}

// ---------------------------------------------------------------------------
// Mutual Exclusion
// ---------------------------------------------------------------------------

const inTabLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `task` while holding the named lock. Uses the Web Locks API, which
 * excludes every tab of this origin, and falls back to an in-tab promise
 * chain where it is unavailable. With `ifAvailable`, returns null instead of
 * waiting when the lock is held.
 */
export async function runExclusive<T>(
  name: string,
  task: () => Promise<T>,
  options: { ifAvailable?: boolean } = {}
): Promise<T | null> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    return locks.request(name, { ifAvailable: options.ifAvailable ?? false }, (lock) =>
      lock ? task() : null
    );
  }

  const previous = inTabLocks.get(name);
  if (previous && options.ifAvailable) return null;
  const run = (previous ?? Promise.resolve()).catch(() => undefined).then(task);
  inTabLocks.set(name, run);
  try {
    return await run;
  } finally {
    if (inTabLocks.get(name) === run) inTabLocks.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Serialization & Deserialization
// ---------------------------------------------------------------------------

export function serializeMutation(mutation: QueuedSquadMutation): string {
  return JSON.stringify(mutation);
}

export function deserializeMutation(serialized: string): QueuedSquadMutation {
  const parsed = JSON.parse(serialized);
  if (!parsed.id || !parsed.action || !parsed.payload || typeof parsed.timestamp !== "number") {
    throw new Error("Invalid serialized squad mutation");
  }
  return parsed as QueuedSquadMutation;
}

// ---------------------------------------------------------------------------
// Conflict Detection
// ---------------------------------------------------------------------------

/**
 * Checks whether an incoming mutation targets the same squad or manager as an existing queued mutation.
 */
export function detectMutationConflict(
  existing: QueuedSquadMutation,
  incoming: { squadId?: number | string | null; userId?: string | null }
): boolean {
  if (incoming.squadId && existing.squadId && String(incoming.squadId) === String(existing.squadId)) {
    return true;
  }
  if (!incoming.squadId && !existing.squadId && incoming.userId && existing.userId && incoming.userId === existing.userId) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Queue Operations
// ---------------------------------------------------------------------------

function notifyQueueChange(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent("offline-queue-change"));
    } catch {
      // Ignore in non-browser contexts
    }
  }
}

/**
 * Enqueue squad mutation. If a pending mutation for the same squad already exists,
 * conflict resolution replaces the older mutation with the latest squad tactics.
 * Payloads are full lineup states (the API replaces the squad), so the newest
 * one subsumes the older; the merged entry moves to the end of the causal order.
 * O(n) in the queue length, which coalescing bounds by the number of squads.
 */
export async function enqueueSquadMutation(data: {
  squadId?: number | string | null;
  userId?: string | null;
  action?: "update" | "create";
  payload: SquadMutationPayload;
  baseRevision?: string;
}): Promise<QueuedSquadMutation> {
  const mutation = (await runExclusive(QUEUE_LOCK, async () => {
    const storage = getQueueStorage();
    const existingMutations = await storage.getAll();

    const conflicting = existingMutations.find(
      (m) => m.status === "pending" && detectMutationConflict(m, data)
    );

    const queued: QueuedSquadMutation = {
      id: conflicting ? conflicting.id : `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      squadId: data.squadId ?? null,
      userId: data.userId ?? null,
      action: data.action ?? (data.squadId ? "update" : "create"),
      payload: data.payload,
      baseRevision: conflicting?.baseRevision ?? data.baseRevision,
      timestamp: Date.now(),
      seq: existingMutations.reduce((max, m) => Math.max(max, m.seq ?? 0), 0) + 1,
      retryCount: 0,
      status: "pending",
    };

    await storage.put(queued);
    return queued;
  }))!;
  notifyQueueChange();

  // Attempt to register background sync with the service worker
  registerBackgroundSync().catch(() => {});

  return mutation;
}

export async function getQueuedMutations(): Promise<QueuedSquadMutation[]> {
  const storage = getQueueStorage();
  return storage.getAll();
}

/** Whether a manager has lineup changes that the server has not accepted yet. */
export async function hasUnsyncedMutations(userId: string): Promise<boolean> {
  const all = await getQueueStorage().getAll();
  return all.some((m) => m.userId === userId && m.status !== "failed");
}

export async function getQueuedMutationCount(): Promise<number> {
  const storage = getQueueStorage();
  const all = await storage.getAll();
  return all.filter((m) => m.status === "pending" || m.status === "syncing" || m.status === "conflict").length;
}

export async function removeQueuedMutation(id: string): Promise<void> {
  const storage = getQueueStorage();
  await storage.delete(id);
  notifyQueueChange();
}

export async function incrementMutationRetry(
  id: string,
  error?: string
): Promise<QueuedSquadMutation | null> {
  const storage = getQueueStorage();
  const mutation = await storage.get(id);
  if (!mutation) return null;

  mutation.retryCount += 1;
  mutation.lastError = error || "Sync failed";

  if (mutation.retryCount >= MAX_QUEUE_RETRIES) {
    mutation.status = "failed";
  } else {
    mutation.status = "pending";
  }

  await storage.put(mutation);
  notifyQueueChange();
  return mutation;
}

export async function clearQueuedMutations(): Promise<void> {
  const storage = getQueueStorage();
  await storage.clear();
  notifyQueueChange();
}

export async function updateQueuedMutationRevision(id: string, revision: string): Promise<void> {
  const storage = getQueueStorage();
  const mutation = await storage.get(id);
  if (!mutation) return;
  mutation.baseRevision = revision;
  mutation.serverRevision = undefined;
  mutation.status = "pending";
  mutation.retryCount = 0;
  mutation.lastError = undefined;
  await storage.put(mutation);
  notifyQueueChange();
}

// ---------------------------------------------------------------------------
// Background Sync Registration
// ---------------------------------------------------------------------------

export async function registerBackgroundSync(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    if ("sync" in registration && typeof (registration as any).sync?.register === "function") {
      await (registration as any).sync.register(SYNC_TAG);
      return true;
    }
  } catch (err) {
    console.warn("[OfflineQueue] Background sync registration failed:", err);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sync Dispatcher & Conflict Resolution
// ---------------------------------------------------------------------------

/**
 * offline / unauthorized / transient: the mutation stays queued and the flush
 * stops, so later mutations cannot overtake it. rejected: the server refused
 * the mutation itself; replaying it can never succeed.
 */
export type SyncFailureKind = "offline" | "unauthorized" | "transient" | "rejected";

export type RejectionReason =
  | "DEADLINE_PASSED"
  | "INVALID_SQUAD"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RETRIES_EXHAUSTED"
  | "REJECTED";

export interface RejectedMutation {
  mutation: QueuedSquadMutation;
  reason: RejectionReason;
  message: string;
}

export interface SyncResult {
  succeeded: number;
  failed: number;
  syncedIds: string[];
  /** Mutations dropped from the queue; the local lineup must be rolled back. */
  rejected: RejectedMutation[];
  /** Why the flush stopped early, if it did; "busy" when another tab is flushing. */
  halted: Exclude<SyncFailureKind, "rejected"> | "busy" | null;
  conflicts: Array<{ id: string; squadId?: number | string | null; serverRevision: string }>;
}

export function classifySyncError(error: unknown): SyncFailureKind {
  if (isOfflineError(error)) return "offline";
  if (!(error instanceof ApiError)) return "transient";
  if (error.status === 401) return "unauthorized";
  if (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500) {
    return "transient";
  }
  return error.status >= 400 ? "rejected" : "transient";
}

function rejectionReason(error: unknown): RejectionReason {
  if (!(error instanceof ApiError)) return "REJECTED";
  // SquadLockedError responses carry the gameweek deadline (squad.controller.ts)
  if (error.status === 403 && (error.data as { deadline?: unknown } | undefined)?.deadline) {
    return "DEADLINE_PASSED";
  }
  if (error.status === 400 || error.status === 422) return "INVALID_SQUAD";
  if (error.status === 403) return "FORBIDDEN";
  if (error.status === 404) return "NOT_FOUND";
  return "REJECTED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Network error during squad sync";
}

/** Atomically moves a pending mutation to "syncing" and returns its latest payload. */
async function claimMutation(id: string): Promise<QueuedSquadMutation | null> {
  return runExclusive(QUEUE_LOCK, async () => {
    const storage = getQueueStorage();
    const mutation = await storage.get(id);
    if (!mutation || mutation.status !== "pending") return null;
    mutation.status = "syncing";
    await storage.put(mutation);
    return mutation;
  });
}

/** Puts a claimed mutation back in the queue untouched (no retry is charged). */
async function releaseMutation(mutation: QueuedSquadMutation): Promise<void> {
  await getQueueStorage().put({ ...mutation, status: "pending" });
}

/**
 * Replays queued mutations in causal order. Only one tab flushes at a time; a
 * concurrent call returns immediately with `halted: "busy"`.
 */
export async function syncQueuedMutations(apiClient = api): Promise<SyncResult> {
  const result: SyncResult = {
    succeeded: 0,
    failed: 0,
    syncedIds: [],
    rejected: [],
    halted: null,
    conflicts: [],
  };
  const flushed = await runExclusive(FLUSH_LOCK, () => flushQueue(apiClient, result), { ifAvailable: true });
  if (flushed === null) result.halted = "busy";
  notifyQueueChange();
  return result;
}

async function flushQueue(apiClient: typeof api, result: SyncResult): Promise<SyncResult> {
  const storage = getQueueStorage();

  // Holding the flush lock, any "syncing" entry was stranded by a closed tab or reload
  await runExclusive(QUEUE_LOCK, async () => {
    for (const stale of (await storage.getAll()).filter((m) => m.status === "syncing")) {
      await storage.put({ ...stale, status: "pending" });
    }
  });

  const pendingIds = (await storage.getAll()).filter((m) => m.status === "pending").map((m) => m.id);

  for (const id of pendingIds) {
    const mutation = await claimMutation(id);
    if (!mutation) continue;

    try {
      if (mutation.action === "update" && mutation.squadId) {
        await apiClient.put(`/api/v1/squads/${mutation.squadId}`, {
          ...mutation.payload,
          expectedUpdatedAt: mutation.baseRevision,
        });
      } else {
        await apiClient.post("/api/v1/squads", {
          ...mutation.payload,
          userId: mutation.userId,
        });
      }

      await storage.delete(mutation.id);
      result.succeeded += 1;
      result.syncedIds.push(mutation.id);
    } catch (err: unknown) {
      const kind = classifySyncError(err);
      if (kind === "offline" || kind === "unauthorized") {
        await releaseMutation(mutation);
        result.halted = kind;
        break;
      }

      const conflictData = err instanceof ApiError
        ? err.data as { data?: { revision?: unknown } }
        : undefined;
      if (err instanceof ApiError && err.status === 409 && typeof conflictData?.data?.revision === "string") {
        mutation.status = "conflict";
        mutation.serverRevision = conflictData.data.revision;
        mutation.lastError = err.message;
        await storage.put(mutation);
        result.conflicts.push({ id: mutation.id, squadId: mutation.squadId, serverRevision: mutation.serverRevision });
        continue;
      }
      result.failed += 1;
      if (kind === "rejected") {
        await storage.delete(mutation.id);
        result.rejected.push({ mutation, reason: rejectionReason(err), message: errorMessage(err) });
        continue;
      }

      const retried = await incrementMutationRetry(mutation.id, errorMessage(err));
      if (retried?.status === "failed") {
        await storage.delete(mutation.id);
        result.rejected.push({ mutation: retried, reason: "RETRIES_EXHAUSTED", message: errorMessage(err) });
        continue;
      }
      result.halted = "transient";
      break;
    }
  }

  return result;
}
