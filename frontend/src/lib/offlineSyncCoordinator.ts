/**
 * Offline sync coordinator (issue #334).
 *
 * Flushes the IndexedDB squad mutation queue whenever connectivity may have
 * returned: the browser's `online` event, the service worker's Background
 * Sync message, the tab becoming visible again, and app start. Transient
 * failures are retried with exponential backoff; mutations the server rejects
 * (deadline passed, invalid formation) are rolled back to the authoritative
 * server squad with an explanatory toast.
 */
import { api } from "@/lib/api";
import { emitToast } from "@/context/ToastContext";
import {
  hasUnsyncedMutations,
  RejectedMutation,
  SyncResult,
  syncQueuedMutations,
} from "@/lib/offlineQueue";
import { saveSquadSnapshot } from "@/lib/offlineStore";
import { useTeamStore } from "@/store/teamStore";
import { Squad } from "@/types";

const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;
const SW_SYNC_MESSAGE = "SYNC_SQUAD_MUTATIONS";

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

export function describeRejection(rejection: RejectedMutation): string {
  const restored = "Your lineup has been restored to the version saved on the server.";
  switch (rejection.reason) {
    case "DEADLINE_PASSED":
      return `The gameweek deadline passed before your offline lineup change could sync. ${restored}`;
    case "INVALID_SQUAD":
      return `Your offline lineup change was rejected: ${rejection.message} ${restored}`;
    case "RETRIES_EXHAUSTED":
      return `Your offline lineup change couldn't be synced after several attempts. ${restored}`;
    default:
      return `Your offline lineup change couldn't be saved: ${rejection.message} ${restored}`;
  }
}

/**
 * Server state wins once the queue has drained: reload the squad into the
 * store and the offline snapshot. Skipped while newer local edits are still
 * queued, so they are never overwritten by an older server copy.
 */
async function reconcileWithServer(): Promise<void> {
  const { ownerId, hydrateFromSquad } = useTeamStore.getState();
  if (!ownerId || (await hasUnsyncedMutations(ownerId))) return;

  const response = await api.get<{ data: Squad[] }>("/api/v1/squads/me");
  saveSquadSnapshot(ownerId, response.data);
  if (response.data[0]) hydrateFromSquad(response.data[0]);
}

function report(result: SyncResult): void {
  if (result.succeeded > 0) {
    emitToast.success(`Synced ${result.succeeded} offline squad change${result.succeeded === 1 ? "" : "s"}.`);
  }
  for (const rejection of result.rejected) {
    emitToast.error(describeRejection(rejection), { title: "Lineup change not saved", duration: 10_000 });
  }
  if (result.halted === "unauthorized") {
    emitToast.warning("Your session has expired. Sign in again to sync the lineup changes saved on this device.");
  }
}

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Replays the queue now. Safe to call concurrently: only one tab flushes at a time. */
export async function flushOfflineQueue(): Promise<SyncResult> {
  clearRetry();
  const result = await syncQueuedMutations();
  report(result);

  if (result.halted === "transient") {
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** retryAttempt, MAX_RETRY_DELAY_MS);
    retryAttempt++;
    retryTimer = setTimeout(() => void flushOfflineQueue().catch(() => undefined), delay);
  } else if (result.halted !== "busy") {
    retryAttempt = 0;
  }

  if (result.succeeded > 0 || result.rejected.length > 0) {
    await reconcileWithServer().catch(() => undefined);
  }
  return result;
}

/** Wires the flush triggers; returns a function that removes them. */
export function startOfflineSyncCoordinator(): () => void {
  if (typeof window === "undefined") return () => undefined;

  const flush = () => {
    if (navigator.onLine === false) return;
    flushOfflineQueue().catch((error) => console.warn("[OfflineSync] Flush failed:", error));
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") flush();
  };
  const onServiceWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type === SW_SYNC_MESSAGE) flush();
  };

  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", onVisibilityChange);
  navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
  flush();

  return () => {
    window.removeEventListener("online", flush);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
    clearRetry();
  };
}
