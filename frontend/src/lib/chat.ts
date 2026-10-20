import { ChatEntry, ChatMessage, ChatReactionState } from "@/types";

/** Matches the server's limit (services/chat/chatService.ts) */
export const MAX_CHAT_MESSAGE_LENGTH = 500;

/** Quick-reaction emojis available on league chat messages */
export const DEFAULT_CHAT_REACTIONS = ["🔥", "😂", "👏", "⚽"] as const;

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
    let preservedReactions: Record<string, ChatReactionState> | undefined;
    if (!message.status && message.clientId) {
      const draftCopy = byKey.get(`client:${message.clientId}`);
      preservedReactions = draftCopy?.reactions;
      // A confirmed message replaces its optimistic copy
      byKey.delete(`client:${message.clientId}`);
    }
    const existingById = byKey.get(keyOf(message));
    const mergedReactions = message.reactions ?? existingById?.reactions ?? preservedReactions;
    byKey.set(
      keyOf(message),
      mergedReactions ? { ...message, reactions: mergedReactions } : message
    );
  }

  const all = [...byKey.values()];
  const confirmed = all
    .filter((m) => !m.status)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const pending = all.filter((m) => m.status);
  return [...confirmed, ...pending];
}

/**
 * Creates a client-side optimistic chat message with a temporary UUID and
 * `status: "sending"` for immediate insertion into the chat feed.
 */
export function createOptimisticMessage(params: {
  leagueId: string;
  userId: string;
  username: string;
  body: string;
  clientId?: string;
  createdAt?: string;
}): ChatEntry {
  const clientId = params.clientId ?? createClientId();
  return {
    id: clientId,
    clientId,
    leagueId: params.leagueId,
    userId: params.userId,
    username: params.username,
    body: params.body.trim(),
    createdAt: params.createdAt ?? new Date().toISOString(),
    status: "sending",
  };
}

/**
 * Reconciles an optimistic message with the server's canonical message (`id`, `createdAt`)
 * upon receiving the server acknowledgement or broadcast.
 */
export function reconcileOptimisticMessage(
  messages: ChatEntry[],
  canonicalMessage: ChatMessage,
  clientId?: string
): ChatEntry[] {
  return mergeMessages(messages, [{ ...canonicalMessage, clientId }]);
}

/**
 * Transitions an in-flight optimistic message to the `"failed"` state with an error reason.
 */
export function markMessageFailed(
  messages: ChatEntry[],
  clientId: string,
  error: string,
  lostInFlight = false
): ChatEntry[] {
  return messages.map((m) =>
    m.clientId === clientId && m.status === "sending"
      ? { ...m, status: "failed" as const, error, lostInFlight }
      : m
  );
}

/**
 * Rolls back (removes) an optimistic message that failed to send when the user dismisses it.
 */
export function rollbackFailedMessage(messages: ChatEntry[], clientId: string): ChatEntry[] {
  return messages.filter((m) => !(m.clientId === clientId && m.status === "failed"));
}

function cloneReactions(
  reactions: Record<string, ChatReactionState> | undefined
): Record<string, ChatReactionState> | undefined {
  if (!reactions) return undefined;
  const copy: Record<string, ChatReactionState> = {};
  for (const [emoji, state] of Object.entries(reactions)) {
    copy[emoji] = {
      emoji: state.emoji,
      count: state.count,
      userIds: [...state.userIds],
      ...(state.pending !== undefined ? { pending: state.pending } : {}),
    };
  }
  return copy;
}

/**
 * Optimistically toggles a user's emoji reaction on a message, immediately
 * incrementing (or decrementing if already reacted) the counter and returning
 * a snapshot of the previous reactions map for rollback if the request fails.
 */
export function applyOptimisticReaction(
  messages: ChatEntry[],
  messageId: string,
  emoji: string,
  userId: string
): {
  messages: ChatEntry[];
  previousReactions: Record<string, ChatReactionState> | undefined;
  added: boolean;
} {
  let previousReactions: Record<string, ChatReactionState> | undefined;
  let added = false;

  const updated = messages.map((m) => {
    if (m.id !== messageId) return m;
    previousReactions = cloneReactions(m.reactions);

    const nextReactions: Record<string, ChatReactionState> = cloneReactions(m.reactions) ?? {};
    const current = nextReactions[emoji] ?? { emoji, count: 0, userIds: [] };
    const alreadyReacted = current.userIds.includes(userId);

    if (alreadyReacted) {
      const nextUsers = current.userIds.filter((id) => id !== userId);
      const nextCount = Math.max(0, current.count - 1);
      if (nextCount === 0) {
        delete nextReactions[emoji];
      } else {
        nextReactions[emoji] = {
          emoji,
          count: nextCount,
          userIds: nextUsers,
          pending: true,
        };
      }
      added = false;
    } else {
      nextReactions[emoji] = {
        emoji,
        count: current.count + 1,
        userIds: [...current.userIds, userId],
        pending: true,
      };
      added = true;
    }

    return {
      ...m,
      reactions: Object.keys(nextReactions).length > 0 ? nextReactions : undefined,
    };
  });

  return { messages: updated, previousReactions, added };
}

/**
 * Clears the pending flag (or applies the canonical server reaction state) once
 * a reaction API/socket request succeeds.
 */
export function reconcileReactionSuccess(
  messages: ChatEntry[],
  messageId: string,
  emoji: string,
  serverReactions?: Record<string, ChatReactionState>
): ChatEntry[] {
  return messages.map((m) => {
    if (m.id !== messageId) return m;
    if (serverReactions) {
      return {
        ...m,
        reactions: Object.keys(serverReactions).length > 0 ? cloneReactions(serverReactions) : undefined,
      };
    }
    if (!m.reactions || !m.reactions[emoji]) return m;
    const nextReactions = cloneReactions(m.reactions)!;
    const target = nextReactions[emoji];
    if (target) {
      delete target.pending;
    }
    return { ...m, reactions: nextReactions };
  });
}

/**
 * Rolls back a message's emoji reactions to the snapshot captured before the
 * optimistic update when the server rejects or fails to process the reaction.
 */
export function rollbackOptimisticReaction(
  messages: ChatEntry[],
  messageId: string,
  previousReactions: Record<string, ChatReactionState> | undefined
): ChatEntry[] {
  return messages.map((m) => {
    if (m.id !== messageId) return m;
    return {
      ...m,
      reactions: cloneReactions(previousReactions),
    };
  });
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
