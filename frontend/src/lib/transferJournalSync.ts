/**
 * transferJournalSync.ts — FantasyXI Issue #457
 *
 * Reconnect sync for the offline transfer journal.
 *
 * On reconnect: replay the pending journal onto the last synced server
 * state (base), fetch the current server squad (remote), run the 3-way
 * merge, and —
 *
 *   - no conflicts: commit the merged squad to the existing backend API
 *     (`PUT /api/v1/squads/:id`, or `POST /api/v1/squads` for a new squad)
 *     and mark the journal entries synced;
 *   - conflicts: hold the entries as "conflicted", commit nothing, and
 *     notify subscribers (the team page opens the resolution modal).
 *
 * There is no dedicated backend merge endpoint: the client performs the
 * merge and commits the merged squad through the existing squad update,
 * guarded by `expectedUpdatedAt` (the base revision) so a concurrent
 * server change still surfaces as a 409 instead of silently overwriting.
 * A 403 carrying a deadline is turned into a deadline-locked conflict
 * instead of a rejection.
 *
 * `fetchRemote` / `commit` are injectable so the tests can drive the sync
 * against a fake API; the defaults use the real `api` client.
 */

import { api, ApiError } from "@/lib/api";
import { Squad } from "@/types";
import {
  clearJournalBase,
  getJournalBase,
  getPendingJournalEntries,
  JournalPlayer,
  markJournalEntries,
  replayJournal,
  touchedPlayerIds,
} from "./transferJournal";
import {
  applyMergeResolutions,
  journalPlayersToMergePlayers,
  MergeConflict,
  MergePlayer,
  MergeResolutionMap,
  squadPlayersToMergePlayers,
  threeWayMerge,
} from "./mergeResolver";

export interface RemoteSquadState {
  squadId: string;
  name: string;
  revision?: string;
  players: MergePlayer[];
  /** Players unavailable upstream (transferred out / not in the pool). */
  unavailablePlayerIds: number[];
}

export interface JournalSyncDeps {
  squadId: string | null;
  userId: string | null;
  squadName: string;
  apiClient?: typeof api;
  fetchRemote?: () => Promise<RemoteSquadState | null>;
  commit?: (payload: { name: string; players: Array<{ playerId: number; isStarter: boolean; isCaptain: boolean; isViceCaptain: boolean; positionOrder: number }>; expectedUpdatedAt?: string }) => Promise<unknown>;
}

export type JournalSyncOutcome =
  | { status: "idle"; committed: 0 }
  | { status: "synced"; committed: number; merged: MergePlayer[]; autoMerged: string[] }
  | {
      status: "conflicts";
      committed: 0;
      conflicts: MergeConflict[];
      merged: MergePlayer[];
      base: MergePlayer[];
      local: MergePlayer[];
      remote: MergePlayer[];
      autoMerged: string[];
      baseFromRemote: boolean;
    };

export interface JournalResolveOutcome {
  status: "synced" | "held" | "discarded";
  players?: MergePlayer[];
}

// ---------------------------------------------------------------------------
// Subscribers (the team page opens the modal from these)
// ---------------------------------------------------------------------------

type ConflictListener = (outcome: Extract<JournalSyncOutcome, { status: "conflicts" }>) => void;

const conflictListeners = new Set<ConflictListener>();

export function subscribeTransferConflicts(listener: ConflictListener): () => void {
  conflictListeners.add(listener);
  return () => {
    conflictListeners.delete(listener);
  };
}

function notifyConflicts(outcome: Extract<JournalSyncOutcome, { status: "conflicts" }>): void {
  for (const listener of conflictListeners) {
    try {
      listener(outcome);
    } catch {
      // A listener must never break the sync
    }
  }
}

// ---------------------------------------------------------------------------
// Default remote fetch / commit (existing backend endpoints)
// ---------------------------------------------------------------------------

async function defaultFetchRemote(deps: JournalSyncDeps): Promise<RemoteSquadState | null> {
  const client = deps.apiClient ?? api;
  const response = await client.get<{ data: Squad[] }>("/api/v1/squads/me");
  const squad = response.data.find((s) => String(s.id) === String(deps.squadId)) ?? response.data[0];
  if (!squad) return null;
  const players = squadPlayersToMergePlayers(squad.players ?? []);
  return {
    squadId: String(squad.id),
    name: squad.name,
    revision: squad.updatedAt,
    players,
    unavailablePlayerIds: players.filter((p) => !p.isAvailable).map((p) => p.playerId),
  };
}

async function defaultCommit(
  deps: JournalSyncDeps,
  payload: Parameters<NonNullable<JournalSyncDeps["commit"]>>[0]
): Promise<unknown> {
  const client = deps.apiClient ?? api;
  if (deps.squadId) {
    return client.put(`/api/v1/squads/${deps.squadId}`, payload);
  }
  return client.post("/api/v1/squads", { ...payload, userId: deps.userId });
}

function buildCommitPayload(
  squadName: string,
  merged: MergePlayer[],
  expectedUpdatedAt?: string
): Parameters<NonNullable<JournalSyncDeps["commit"]>>[0] {
  return {
    name: squadName,
    players: merged.map((p, idx) => ({
      playerId: p.playerId,
      isStarter: p.isStarter,
      isCaptain: p.isCaptain,
      isViceCaptain: p.isViceCaptain,
      positionOrder: idx + 1,
    })),
    expectedUpdatedAt,
  };
}

function deadlineFromError(error: unknown): string | undefined {
  if (error instanceof ApiError && error.status === 403) {
    const data = error.data as { deadline?: unknown } | undefined;
    if (typeof data?.deadline === "string") return data.deadline;
    return "passed";
  }
  return undefined;
}

/** The 3-way merge input for one sync run, shared by sync + resolve. */
export interface MergeContext {
  entries: Array<{ id: string }>;
  base: MergePlayer[];
  local: MergePlayer[];
  remote: MergePlayer[];
  baseFromRemote: boolean;
  baseRevision?: string;
}

export async function syncTransferJournal(deps: JournalSyncDeps): Promise<JournalSyncOutcome> {
  const entries = await getPendingJournalEntries(deps.squadId);
  if (entries.length === 0) return { status: "idle", committed: 0 };

  const entryIds = entries.map((e) => e.id);
  const remote = (await (deps.fetchRemote ? deps.fetchRemote() : defaultFetchRemote(deps))) ?? null;
  if (!remote) {
    // No server squad to merge against: keep the draft queued.
    return { status: "idle", committed: 0 };
  }

  // Base: the snapshot taken when the draft started. Without one (e.g. the
  // journal predates the base feature) the remote state stands in as the
  // base, so only the draft's own touches can conflict.
  const storedBase = deps.squadId ? await getJournalBase(deps.squadId) : undefined;
  const basePlayers: JournalPlayer[] = storedBase
    ? storedBase.players
    : remote.players.map((p) => ({
        playerId: p.playerId,
        player: {
          id: p.playerId,
          fplId: p.playerId,
          firstName: "",
          lastName: p.displayName,
          displayName: p.displayName,
          position: p.position,
          teamId: p.teamId,
          price: p.price,
          totalPoints: 0,
          minutesPlayed: 0,
          goalsScored: 0,
          assists: 0,
          cleanSheets: 0,
          photoUrl: null,
          isAvailable: p.isAvailable,
        },
        isStarter: p.isStarter,
        isCaptain: p.isCaptain,
        isViceCaptain: p.isViceCaptain,
        positionOrder: p.positionOrder,
      }));
  const base = journalPlayersToMergePlayers(basePlayers);
  const local = journalPlayersToMergePlayers(replayJournal(basePlayers, entries));
  const touched = touchedPlayerIds(entries);

  const merge = threeWayMerge({
    base,
    local,
    remote: remote.players,
    touchedPlayerIds: touched,
    unavailablePlayerIds: remote.unavailablePlayerIds,
  });

  if (merge.conflicts.length > 0) {
    await markJournalEntries(entryIds, "conflicted");
    const outcome: Extract<JournalSyncOutcome, { status: "conflicts" }> = {
      status: "conflicts",
      committed: 0,
      conflicts: merge.conflicts,
      merged: merge.merged,
      base,
      local,
      remote: remote.players,
      autoMerged: merge.autoMerged,
      baseFromRemote: !storedBase,
    };
    notifyConflicts(outcome);
    return outcome;
  }

  const payload = buildCommitPayload(deps.squadName, merge.merged, storedBase?.revision ?? remote.revision);
  try {
    if (deps.commit) await deps.commit(payload);
    else await defaultCommit(deps, payload);
  } catch (error) {
    const deadline = deadlineFromError(error);
    if (deadline) {
      // The deadline locked while the draft was offline: hold the draft
      // for an explicit decision instead of dropping it as a rejection.
      const locked = threeWayMerge({
        base,
        local,
        remote: remote.players,
        touchedPlayerIds: touched,
        unavailablePlayerIds: remote.unavailablePlayerIds,
        deadlineLocked: true,
        deadline,
      });
      await markJournalEntries(entryIds, "conflicted");
      const outcome: Extract<JournalSyncOutcome, { status: "conflicts" }> = {
        status: "conflicts",
        committed: 0,
        conflicts: locked.conflicts,
        merged: locked.merged,
        base,
        local,
        remote: remote.players,
        autoMerged: merge.autoMerged,
        baseFromRemote: !storedBase,
      };
      notifyConflicts(outcome);
      return outcome;
    }
    throw error;
  }

  await markJournalEntries(entryIds, "synced");
  if (deps.squadId) await clearJournalBase(deps.squadId);
  return { status: "synced", committed: entryIds.length, merged: merge.merged, autoMerged: merge.autoMerged };
}

export interface ResolveTransferConflictsDeps extends JournalSyncDeps {
  conflicts: MergeConflict[];
  resolutions: MergeResolutionMap;
  base: MergePlayer[];
  local: MergePlayer[];
  remote: MergePlayer[];
  merged: MergePlayer[];
}

/**
 * Applies the manager's modal choices and resumes the sync. A locked
 * deadline is special: "mine" keeps the draft saved on the device
 * (nothing is committed), "server" discards it.
 */
export async function resolveTransferConflicts(
  deps: ResolveTransferConflictsDeps
): Promise<JournalResolveOutcome> {
  const entries = await getPendingJournalEntries(deps.squadId);
  const entryIds = entries.map((e) => e.id);

  const deadlineConflict = deps.conflicts.find((c) => c.kind === "deadline-locked");
  if (deadlineConflict) {
    if ((deps.resolutions[deadlineConflict.id] ?? "server") === "mine") {
      await markJournalEntries(entryIds, "pending");
      return { status: "held" };
    }
    await markJournalEntries(entryIds, "discarded");
    if (deps.squadId) await clearJournalBase(deps.squadId);
    return { status: "discarded" };
  }

  const players = applyMergeResolutions({
    base: deps.base,
    local: deps.local,
    remote: deps.remote,
    merged: deps.merged,
    conflicts: deps.conflicts,
    resolutions: deps.resolutions,
  });
  const payload = buildCommitPayload(deps.squadName, players);
  if (deps.commit) await deps.commit(payload);
  else await defaultCommit(deps, payload);

  await markJournalEntries(entryIds, "synced");
  if (deps.squadId) await clearJournalBase(deps.squadId);
  return { status: "synced", players };
}
