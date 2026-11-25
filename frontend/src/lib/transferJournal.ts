/**
 * transferJournal.ts — FantasyXI Issue #457
 *
 * Offline-first squad transfer journal persisted in IndexedDB.
 *
 * While disconnected, every draft transfer action (transfer in/out, captain
 * or vice-captain change, formation shift) is appended as a journal entry
 * with a monotonically increasing `seq` and a per-device state vector, so
 * the draft can be replayed, reviewed and merged after reconnecting.
 *
 * This extends — it does not replace — the existing offline queue
 * (`offlineQueue.ts`): the queue carries the full-snapshot squad mutation
 * that is committed to the API, while the journal carries the granular
 * draft actions the 3-way merge (`mergeResolver.ts`) reasons about.
 *
 * Storage follows the same pattern as `offlineQueue.ts`: an IndexedDB
 * implementation for browsers and an in-memory implementation used by the
 * tests (the repo has no fake-indexeddb dependency).
 */

import { Player, SQUAD_RULES } from "@/types";
import { detectFormation, validateCompleteSquad } from "@/lib/formation";

export const JOURNAL_DB_NAME = "fantasyxi-transfer-journal";
export const JOURNAL_DB_VERSION = 1;
export const JOURNAL_STORE = "journal_entries";
export const JOURNAL_BASE_STORE = "journal_bases";
export const JOURNAL_CLIENT_ID_KEY = "fxi:journal:client-id";

/** One draft action made while offline (or while a sync is pending). */
export type JournalEntryKind =
  | "transfer" // replace one player with another, keeping the slot
  | "transfer-in"
  | "transfer-out"
  | "captain"
  | "vice-captain"
  | "formation"; // starter/bench swap between two players

export type JournalEntryStatus = "pending" | "synced" | "conflicted" | "discarded";

export interface TransferJournalEntry {
  id: string;
  squadId: string | null;
  userId: string | null;
  kind: JournalEntryKind;
  /** Causal position: replay order, persisted so it survives reloads. */
  seq: number;
  /** Device that recorded the entry; the state vector is keyed by this. */
  clientId: string;
  createdAt: number;
  status: JournalEntryStatus;
  baseRevision?: string;
  /** Primary player: incoming player for a transfer, new captain, swap side A. */
  playerId?: number;
  /** Player removed by a transfer / transfer-out. */
  outgoingPlayerId?: number;
  /** Formation swap partner (side B). */
  otherPlayerId?: number;
  /** Snapshot of the incoming player, taken when the draft was made. */
  playerSnapshot?: Player;
  /** Slot the incoming player takes over in a transfer (from the outgoing player). */
  isStarter?: boolean;
  positionOrder?: number;
  note?: string;
}

/** A squad player as the journal sees it: snapshot + tactical flags. */
export interface JournalPlayer {
  playerId: number;
  player: Player;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number;
}

/** Last synced server state for a squad: the `base` of the 3-way merge. */
export interface JournalBase {
  squadId: string;
  players: JournalPlayer[];
  revision?: string;
  savedAt: number;
}

/** State vector: highest `seq` seen from each client. */
export type StateVector = Record<string, number>;

export function getStateVector(entries: TransferJournalEntry[]): StateVector {
  const vector: StateVector = {};
  for (const entry of entries) {
    vector[entry.clientId] = Math.max(vector[entry.clientId] ?? 0, entry.seq);
  }
  return vector;
}

/** True when `vector` already covers `entry` (it was seen / replayed). */
export function entrySeenBy(vector: StateVector, entry: TransferJournalEntry): boolean {
  return (vector[entry.clientId] ?? 0) >= entry.seq;
}

/** Replay order: by causal sequence, then by creation time. */
export function compareJournalOrder(a: TransferJournalEntry, b: TransferJournalEntry): number {
  return a.seq - b.seq || a.createdAt - b.createdAt;
}

/** Player ids the draft touched — the merge only treats those as conflicting. */
export function touchedPlayerIds(entries: TransferJournalEntry[]): Set<number> {
  const touched = new Set<number>();
  for (const entry of entries) {
    if (entry.playerId !== undefined) touched.add(entry.playerId);
    if (entry.outgoingPlayerId !== undefined) touched.add(entry.outgoingPlayerId);
    if (entry.otherPlayerId !== undefined) touched.add(entry.otherPlayerId);
  }
  return touched;
}

export function summarizeJournal(entries: TransferJournalEntry[]): {
  total: number;
  byKind: Partial<Record<JournalEntryKind, number>>;
  touched: number[];
} {
  const byKind: Partial<Record<JournalEntryKind, number>> = {};
  for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  return { total: entries.length, byKind, touched: [...touchedPlayerIds(entries)].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface TransferJournalStorage {
  getEntries(): Promise<TransferJournalEntry[]>;
  putEntry(entry: TransferJournalEntry): Promise<void>;
  deleteEntry(id: string): Promise<void>;
  clearEntries(): Promise<void>;
  getBase(squadId: string): Promise<JournalBase | undefined>;
  putBase(base: JournalBase): Promise<void>;
  deleteBase(squadId: string): Promise<void>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryJournalStorage implements TransferJournalStorage {
  private entries = new Map<string, TransferJournalEntry>();
  private bases = new Map<string, JournalBase>();

  async getEntries(): Promise<TransferJournalEntry[]> {
    return [...this.entries.values()].map(clone).sort(compareJournalOrder);
  }

  async putEntry(entry: TransferJournalEntry): Promise<void> {
    this.entries.set(entry.id, clone(entry));
  }

  async deleteEntry(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async clearEntries(): Promise<void> {
    this.entries.clear();
  }

  async getBase(squadId: string): Promise<JournalBase | undefined> {
    const base = this.bases.get(squadId);
    return base ? clone(base) : undefined;
  }

  async putBase(base: JournalBase): Promise<void> {
    this.bases.set(base.squadId, clone(base));
  }

  async deleteBase(squadId: string): Promise<void> {
    this.bases.delete(squadId);
  }
}

export class IndexedDBJournalStorage implements TransferJournalStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not supported in this environment"));
        return;
      }
      const request = indexedDB.open(JOURNAL_DB_NAME, JOURNAL_DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(JOURNAL_STORE)) {
          const store = db.createObjectStore(JOURNAL_STORE, { keyPath: "id" });
          store.createIndex("by_squadId", "squadId", { unique: false });
          store.createIndex("by_status", "status", { unique: false });
          store.createIndex("by_seq", "seq", { unique: false });
        }
        if (!db.objectStoreNames.contains(JOURNAL_BASE_STORE)) {
          db.createObjectStore(JOURNAL_BASE_STORE, { keyPath: "squadId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.dbPromise;
  }

  private async run<T>(storeName: string, mode: IDBTransactionMode, task: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.openDB();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = task(tx.objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getEntries(): Promise<TransferJournalEntry[]> {
    const entries = (await this.run(JOURNAL_STORE, "readonly", (s) => s.getAll())) || [];
    return (entries as TransferJournalEntry[]).sort(compareJournalOrder);
  }

  async putEntry(entry: TransferJournalEntry): Promise<void> {
    await this.run(JOURNAL_STORE, "readwrite", (s) => s.put(entry));
  }

  async deleteEntry(id: string): Promise<void> {
    await this.run(JOURNAL_STORE, "readwrite", (s) => s.delete(id));
  }

  async clearEntries(): Promise<void> {
    await this.run(JOURNAL_STORE, "readwrite", (s) => s.clear());
  }

  async getBase(squadId: string): Promise<JournalBase | undefined> {
    return this.run(JOURNAL_BASE_STORE, "readonly", (s) => s.get(squadId));
  }

  async putBase(base: JournalBase): Promise<void> {
    await this.run(JOURNAL_BASE_STORE, "readwrite", (s) => s.put(base));
  }

  async deleteBase(squadId: string): Promise<void> {
    await this.run(JOURNAL_BASE_STORE, "readwrite", (s) => s.delete(squadId));
  }
}

let activeStorage: TransferJournalStorage | null = null;

export function getJournalStorage(): TransferJournalStorage {
  if (activeStorage) return activeStorage;
  if (typeof indexedDB !== "undefined") {
    activeStorage = new IndexedDBJournalStorage();
  } else {
    activeStorage = new MemoryJournalStorage();
  }
  return activeStorage;
}

export function setCustomJournalStorageForTest(storage: TransferJournalStorage | null): void {
  activeStorage = storage;
}

// ---------------------------------------------------------------------------
// Client id (one stable id per browser, for the state vector)
// ---------------------------------------------------------------------------

let cachedClientId: string | null = null;

export function getJournalClientId(): string {
  if (cachedClientId) return cachedClientId;
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(JOURNAL_CLIENT_ID_KEY) : null;
    if (stored) {
      cachedClientId = stored;
      return stored;
    }
    const fresh = `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      localStorage?.setItem(JOURNAL_CLIENT_ID_KEY, fresh);
    } catch {
      // Private mode: the id just won't survive a reload
    }
    cachedClientId = fresh;
    return fresh;
  } catch {
    cachedClientId = `client_${Math.random().toString(36).slice(2, 10)}`;
    return cachedClientId;
  }
}

/** Test hook: forget the cached client id so a fresh one is generated. */
export function resetJournalClientIdForTest(): void {
  cachedClientId = null;
}

// ---------------------------------------------------------------------------
// Journal operations
// ---------------------------------------------------------------------------

export type NewJournalEntry = Omit<
  TransferJournalEntry,
  "id" | "seq" | "clientId" | "createdAt" | "status"
> & { status?: JournalEntryStatus };

/**
 * Appends one draft action. The sequence is global and monotonically
 * increasing, so replay order survives reloads and coalescing.
 */
export async function appendJournalEntry(input: NewJournalEntry): Promise<TransferJournalEntry> {
  const storage = getJournalStorage();
  const existing = await storage.getEntries();
  const entry: TransferJournalEntry = {
    ...input,
    id: `jnl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    seq: existing.reduce((max, e) => Math.max(max, e.seq), 0) + 1,
    clientId: getJournalClientId(),
    createdAt: Date.now(),
    status: input.status ?? "pending",
  };
  await storage.putEntry(entry);
  notifyJournalChange();
  return entry;
}

export async function getJournalEntries(squadId?: string | null): Promise<TransferJournalEntry[]> {
  const entries = await getJournalStorage().getEntries();
  return squadId === undefined ? entries : entries.filter((e) => e.squadId === squadId);
}

export async function getPendingJournalEntries(squadId?: string | null): Promise<TransferJournalEntry[]> {
  return (await getJournalEntries(squadId)).filter((e) => e.status === "pending" || e.status === "conflicted");
}

export async function markJournalEntries(ids: string[], status: JournalEntryStatus): Promise<void> {
  const storage = getJournalStorage();
  for (const id of ids) {
    const entry = (await storage.getEntries()).find((e) => e.id === id);
    if (entry) await storage.putEntry({ ...entry, status });
  }
  notifyJournalChange();
}

export async function clearJournalEntries(squadId?: string | null): Promise<void> {
  const storage = getJournalStorage();
  if (squadId === undefined) {
    await storage.clearEntries();
  } else {
    for (const entry of await storage.getEntries()) {
      if (entry.squadId === squadId) await storage.deleteEntry(entry.id);
    }
  }
  notifyJournalChange();
}

function notifyJournalChange(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent("transfer-journal-change"));
    } catch {
      // Ignore in non-browser contexts
    }
  }
}

// ---------------------------------------------------------------------------
// Base snapshot (last synced server state)
// ---------------------------------------------------------------------------

/**
 * Records the server state the draft started from — but only the first
 * time, so later offline edits never overwrite the merge base with a draft.
 */
export async function ensureJournalBase(
  squadId: string,
  players: JournalPlayer[],
  revision?: string
): Promise<JournalBase> {
  const storage = getJournalStorage();
  const existing = await storage.getBase(squadId);
  if (existing) return existing;
  const base: JournalBase = { squadId, players: clone(players), revision, savedAt: Date.now() };
  await storage.putBase(base);
  return base;
}

export async function getJournalBase(squadId: string): Promise<JournalBase | undefined> {
  return getJournalStorage().getBase(squadId);
}

export async function clearJournalBase(squadId: string): Promise<void> {
  await getJournalStorage().deleteBase(squadId);
}

// ---------------------------------------------------------------------------
// Replay & draft review (pure: full squad editing while disconnected)
// ---------------------------------------------------------------------------

/** Replays journal entries onto the base squad, in causal order. */
export function replayJournal(base: JournalPlayer[], entries: TransferJournalEntry[]): JournalPlayer[] {
  const players: JournalPlayer[] = clone(base);
  const ordered = [...entries].sort(compareJournalOrder);

  for (const entry of ordered) {
    if (entry.status === "discarded") continue;
    switch (entry.kind) {
      case "transfer":
      case "transfer-in": {
        if (!entry.playerSnapshot || entry.playerId === undefined) break;
        const incoming: JournalPlayer = {
          playerId: entry.playerId,
          player: entry.playerSnapshot,
          isStarter: entry.isStarter ?? false,
          isCaptain: false,
          isViceCaptain: false,
          positionOrder: entry.positionOrder ?? players.length + 1,
        };
        const outgoingIdx =
          entry.outgoingPlayerId !== undefined
            ? players.findIndex((p) => p.playerId === entry.outgoingPlayerId)
            : -1;
        if (outgoingIdx >= 0) {
          // Keep the slot: starter state, armbands and order move to the new player.
          const outgoing = players[outgoingIdx];
          incoming.isStarter = outgoing.isStarter;
          incoming.isCaptain = outgoing.isCaptain;
          incoming.isViceCaptain = outgoing.isViceCaptain;
          incoming.positionOrder = outgoing.positionOrder;
          players[outgoingIdx] = incoming;
        } else if (!players.some((p) => p.playerId === incoming.playerId)) {
          players.push(incoming);
        }
        break;
      }
      case "transfer-out": {
        if (entry.playerId === undefined) break;
        const idx = players.findIndex((p) => p.playerId === entry.playerId);
        if (idx >= 0) players.splice(idx, 1);
        break;
      }
      case "captain": {
        if (entry.playerId === undefined) break;
        for (const p of players) {
          p.isCaptain = p.playerId === entry.playerId;
          if (p.playerId === entry.playerId) p.isViceCaptain = false;
        }
        break;
      }
      case "vice-captain": {
        if (entry.playerId === undefined) break;
        for (const p of players) {
          p.isViceCaptain = p.playerId === entry.playerId;
          if (p.playerId === entry.playerId) p.isCaptain = false;
        }
        break;
      }
      case "formation": {
        if (entry.playerId === undefined || entry.otherPlayerId === undefined) break;
        const a = players.find((p) => p.playerId === entry.playerId);
        const b = players.find((p) => p.playerId === entry.otherPlayerId);
        if (!a || !b) break;
        // Mirror teamStore.handleSwap: swap starter state and order, and
        // move the armbands onto the pitch when a starter is benched.
        const starterA = a.isStarter;
        const orderA = a.positionOrder;
        a.isStarter = b.isStarter;
        a.positionOrder = b.positionOrder;
        b.isStarter = starterA;
        b.positionOrder = orderA;
        for (const [off, on] of [
          [a, b],
          [b, a],
        ] as const) {
          if (!off.isStarter && off.isCaptain) {
            off.isCaptain = false;
            on.isCaptain = true;
          }
          if (!off.isStarter && off.isViceCaptain) {
            off.isViceCaptain = false;
            on.isViceCaptain = true;
          }
        }
        break;
      }
    }
  }

  players.sort((a, b) => a.positionOrder - b.positionOrder || a.playerId - b.playerId);
  return players;
}

export interface DraftBudget {
  /** Prices are stored in tenths, e.g. 1000 = £100.0m. */
  spentTenths: number;
  spentM: number;
  remainingM: number;
  overBudget: boolean;
  overByM: number;
}

/** Budget recalculation for a draft squad; `priceOverrides` apply live prices. */
export function computeDraftBudget(
  players: Array<{ player?: { price: number } | null; price?: number }>,
  priceOverrides?: Map<number, number> | Record<number, number>
): DraftBudget {
  let spentTenths = 0;
  for (const p of players) {
    const id = (p as { playerId?: number }).playerId ?? (p as { player?: { id?: number } }).player?.id;
    const override =
      id !== undefined
        ? priceOverrides instanceof Map
          ? priceOverrides.get(id)
          : priceOverrides?.[id]
        : undefined;
    spentTenths += override ?? p.price ?? p.player?.price ?? 0;
  }
  const spentM = spentTenths / 10;
  const remainingM = SQUAD_RULES.STARTING_BUDGET - spentM;
  return {
    spentTenths,
    spentM,
    remainingM,
    overBudget: remainingM < 0,
    overByM: remainingM < 0 ? -remainingM : 0,
  };
}

export interface DraftReview {
  players: JournalPlayer[];
  formationBefore: string;
  formationAfter: string;
  budgetBefore: DraftBudget;
  budgetAfter: DraftBudget;
  /** Net spend of the draft vs the base, in £m (positive = spent more). */
  netSpendM: number;
  valid: boolean;
  errors: string[];
  entryCount: number;
}

/**
 * What the manager reviews offline: the replayed draft, the formation
 * shift, the recalculated budget and the usual squad validation.
 */
export function reviewDraft(base: JournalPlayer[], entries: TransferJournalEntry[]): DraftReview {
  const players = replayJournal(base, entries);
  const starters = (list: JournalPlayer[]) => list.filter((p) => p.isStarter);
  const validation = validateCompleteSquad(players);
  const budgetBefore = computeDraftBudget(base);
  const budgetAfter = computeDraftBudget(players);
  return {
    players,
    formationBefore: detectFormation(starters(base)),
    formationAfter: detectFormation(starters(players)),
    budgetBefore,
    budgetAfter,
    netSpendM: budgetAfter.spentM - budgetBefore.spentM,
    valid: validation.valid,
    errors: validation.errors,
    entryCount: entries.length,
  };
}
