import { ChatEntry } from "@/types";

/** Matches the server's limit (services/chat/chatService.ts) */
export const MAX_CHAT_MESSAGE_LENGTH = 500;

/** WebSocket URL for a league's chat, derived from the REST API base URL */
export function chatSocketUrl(apiBaseUrl: string, leagueId: string): string {
  const url = new URL(`/api/v1/leagues/${encodeURIComponent(leagueId)}/chat/ws`, apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Merges incoming messages into the list: de-duplicated by id (and by clientId
 * for the sender's optimistic copies), sorted oldest first. Unsent messages
 * stay at the bottom in the order they were written.
 */
export function mergeMessages(existing: ChatEntry[], incoming: ChatEntry[]): ChatEntry[] {
  const byKey = new Map<string, ChatEntry>();
  const keyOf = (m: ChatEntry) => (m.status ? `client:${m.clientId}` : `id:${m.id}`);

  for (const message of [...existing, ...incoming]) {
    if (!message.status && message.clientId) {
      // A confirmed message replaces its optimistic copy
      byKey.delete(`client:${message.clientId}`);
    }
    byKey.set(keyOf(message), message);
  }

  const all = [...byKey.values()];
  const confirmed = all
    .filter((m) => !m.status)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const pending = all.filter((m) => m.status);
  return [...confirmed, ...pending];
}

/**
 * Removes the sender's drafts that were lost in flight (socket dropped before
 * the ack) once re-synced history shows the server did save them, so they are
 * not shown twice or re-sent. Each saved message accounts for one draft.
 */
export function dropDeliveredDrafts(messages: ChatEntry[], userId: string, clockSkewMs = 60_000): ChatEntry[] {
  const saved = messages.filter((m) => !m.status && m.userId === userId);
  const claimed = new Set<string>();
  return messages.filter((draft) => {
    if (!draft.lostInFlight || draft.status !== "failed") return true;
    const match = saved.find(
      (m) =>
        !claimed.has(m.id) &&
        m.body === draft.body &&
        new Date(m.createdAt).getTime() >= new Date(draft.createdAt).getTime() - clockSkewMs
    );
    if (!match) return true;
    claimed.add(match.id);
    return false;
  });
}

/** Exponential backoff for reconnects: 1s, 2s, 4s ... capped at 30s, with up to 20% jitter */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + 0.2 * random()));
}

/** Close codes after which reconnecting cannot help (see backend realtime/chatSocketServer.ts) */
export const TERMINAL_CLOSE_CODES = new Set([4401, 4403, 4404]);

export function createClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** "14:05" today, "Sat 14:05" this week, otherwise "12 Sep, 14:05" */
export function formatMessageTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const ageMs = now.getTime() - date.getTime();
  if (date.toDateString() === now.toDateString()) return time;
  if (ageMs < 6 * 86_400_000) return `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}
