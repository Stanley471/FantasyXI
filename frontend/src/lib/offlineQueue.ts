/**
 * offlineQueue.ts — FantasyXI Issue #214
 *
 * Offline Squad Mutation Queue backed by IndexedDB with Background Sync
 * support via Service Worker. Persists lineup changes when offline and
 * syncs them when network connectivity is restored.
 */

import { api } from "@/lib/api";

export const DB_NAME = "fantasyxi-offline-queue";
export const DB_VERSION = 1;
export const STORE_NAME = "squad_mutations";
export const SYNC_TAG = "sync-squad-mutations";
export const MAX_QUEUE_RETRIES = 5;

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
  retryCount: number;
  status: "pending" | "syncing" | "failed";
  lastError?: string;
}

export interface OfflineQueueStorage {
  getAll(): Promise<QueuedSquadMutation[]>;
  get(id: string): Promise<QueuedSquadMutation | undefined>;
  put(mutation: QueuedSquadMutation): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

// In-memory fallback / testing storage
export class MemoryQueueStorage implements OfflineQueueStorage {
  private store = new Map<string, QueuedSquadMutation>();

  async getAll(): Promise<QueuedSquadMutation[]> {
    return Array.from(this.store.values()).sort((a, b) => a.timestamp - b.timestamp);
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
        results.sort((a, b) => a.timestamp - b.timestamp);
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
 */
export async function enqueueSquadMutation(data: {
  squadId?: number | string | null;
  userId?: string | null;
  action?: "update" | "create";
  payload: SquadMutationPayload;
}): Promise<QueuedSquadMutation> {
  const storage = getQueueStorage();
  const existingMutations = await storage.getAll();

  const conflicting = existingMutations.find(
    (m) => m.status === "pending" && detectMutationConflict(m, data)
  );

  const mutation: QueuedSquadMutation = {
    id: conflicting ? conflicting.id : `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    squadId: data.squadId ?? null,
    userId: data.userId ?? null,
    action: data.action ?? (data.squadId ? "update" : "create"),
    payload: data.payload,
    timestamp: Date.now(),
    retryCount: 0,
    status: "pending",
  };

  await storage.put(mutation);
  notifyQueueChange();

  // Attempt to register background sync with the service worker
  registerBackgroundSync().catch(() => {});

  return mutation;
}

export async function getQueuedMutations(): Promise<QueuedSquadMutation[]> {
  const storage = getQueueStorage();
  return storage.getAll();
}

export async function getQueuedMutationCount(): Promise<number> {
  const storage = getQueueStorage();
  const all = await storage.getAll();
  return all.filter((m) => m.status === "pending" || m.status === "syncing").length;
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

// ---------------------------------------------------------------------------
// Background Sync Registration
// ---------------------------------------------------------------------------

type SyncRegistration = {
  sync?: {
    register: (tag: string) => Promise<void>;
  };
};

export async function registerBackgroundSync(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const syncRegistration = registration as ServiceWorkerRegistration & SyncRegistration;
    if ("sync" in syncRegistration && typeof syncRegistration.sync?.register === "function") {
      await syncRegistration.sync.register(SYNC_TAG);
      return true;
    }
  } catch (err) {
    console.warn("[OfflineQueue] Background sync registration failed:", err);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sync Dispatcher
// ---------------------------------------------------------------------------

export interface SyncResult {
  succeeded: number;
  failed: number;
  syncedIds: string[];
}

export async function syncQueuedMutations(apiClient = api): Promise<SyncResult> {
  const storage = getQueueStorage();
  const all = await storage.getAll();
  const pending = all.filter((m) => m.status === "pending");

  const result: SyncResult = {
    succeeded: 0,
    failed: 0,
    syncedIds: [],
  };

  for (const mutation of pending) {
    // Mark mutation as syncing
    mutation.status = "syncing";
    await storage.put(mutation);

    try {
      if (mutation.action === "update" && mutation.squadId) {
        await apiClient.put(`/api/v1/squads/${mutation.squadId}`, mutation.payload);
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
      result.failed += 1;
      const errorMsg =
        err instanceof Error ? err.message : "Network error during squad sync";
      await incrementMutationRetry(mutation.id, errorMsg);
    }
  }

  notifyQueueChange();
  return result;
}
