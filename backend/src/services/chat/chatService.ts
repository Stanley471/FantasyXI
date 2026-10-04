import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { MembershipStatus } from "../../types/index.js";

/**
 * League Chat Service.
 *
 * Persists league chat messages and fans them out to live subscribers
 * (WebSocket connections) through the ChatHub. Only the league creator and
 * members whose membership is pending or active may read or post.
 *
 * Laravel equivalent: a ChatService plus a broadcast event (like
 * `broadcast(new MessagePosted($message))->toOthers()` over a private channel).
 */

export const MAX_MESSAGE_LENGTH = 500;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;

/** Messages allowed per user per league within the rate-limit window */
export const RATE_LIMIT_MESSAGES = 5;
export const RATE_LIMIT_WINDOW_MS = 10_000;

const CHAT_MEMBERSHIP_STATUSES: MembershipStatus[] = [MembershipStatus.PENDING, MembershipStatus.ACTIVE];

export interface ChatMessageDto {
  id: string;
  leagueId: string;
  userId: string;
  username: string;
  body: string;
  createdAt: string;
}

export interface ChatHistoryPage {
  messages: ChatMessageDto[];
  /** True when older messages exist before the first message returned */
  hasMore: boolean;
}

export class ChatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatValidationError";
  }
}

export class ChatForbiddenError extends Error {
  constructor(message = "Only league members can use this chat") {
    super(message);
    this.name = "ChatForbiddenError";
  }
}

export class ChatNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatNotFoundError";
  }
}

export class ChatRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("You are sending messages too quickly. Please wait a moment.");
    this.name = "ChatRateLimitError";
  }
}

/**
 * Normalises a message body: strips control characters (keeping newlines),
 * collapses runs of blank lines, trims, and enforces 1..MAX_MESSAGE_LENGTH characters.
 */
export function sanitizeMessageBody(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ChatValidationError("Message must be text");
  }
  const body = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (body.length === 0) {
    throw new ChatValidationError("Message cannot be empty");
  }
  if ([...body].length > MAX_MESSAGE_LENGTH) {
    throw new ChatValidationError(`Message cannot be longer than ${MAX_MESSAGE_LENGTH} characters`);
  }
  return body;
}

/**
 * Sliding-window rate limiter keyed by user and league (in memory, per instance).
 */
export class ChatRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = RATE_LIMIT_MESSAGES,
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Records an attempt; returns 0 when allowed, otherwise the milliseconds to wait. */
  public consume(key: string): number {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return this.windowMs - (now - recent[0]);
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return 0;
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}

type ChatListener = (message: ChatMessageDto) => void;

/**
 * In-process publish/subscribe hub for league chat rooms.
 *
 * Every API instance delivers messages to the sockets connected to it. Running
 * several instances behind a load balancer requires sticky sessions or a shared
 * pub/sub (e.g. Redis) in front of `publish`.
 */
export class ChatHub {
  private readonly rooms = new Map<string, Set<ChatListener>>();

  public subscribe(leagueId: string, listener: ChatListener): () => void {
    const room = this.rooms.get(leagueId) ?? new Set<ChatListener>();
    room.add(listener);
    this.rooms.set(leagueId, room);
    return () => {
      room.delete(listener);
      if (room.size === 0) this.rooms.delete(leagueId);
    };
  }

  public publish(message: ChatMessageDto): void {
    for (const listener of this.rooms.get(message.leagueId) ?? []) {
      try {
        listener(message);
      } catch (error) {
        console.error("[chat] Listener failed:", error);
      }
    }
  }

  public subscriberCount(leagueId: string): number {
    return this.rooms.get(leagueId)?.size ?? 0;
  }
}

function toDto(row: {
  id: string;
  leagueId: string;
  userId: string;
  body: string;
  createdAt: Date;
  user: { username: string };
}): ChatMessageDto {
  return {
    id: row.id,
    leagueId: row.leagueId,
    userId: row.userId,
    username: row.user.username,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ChatService {
  constructor(
    private readonly db: PrismaClient = prisma,
    public readonly hub: ChatHub = new ChatHub(),
    private readonly limiter: ChatRateLimiter = new ChatRateLimiter()
  ) {}

  /** Throws unless the user is the league creator or a pending/active member. */
  public async assertCanAccess(leagueId: string, userId: string): Promise<void> {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      select: { creatorId: true },
    });
    if (!league) {
      throw new ChatNotFoundError("League not found");
    }
    if (league.creatorId === userId) return;

    const member = await this.db.leagueMember.findUnique({
      where: { leagueId_userId: { leagueId, userId } },
      select: { status: true },
    });
    if (!member || !CHAT_MEMBERSHIP_STATUSES.includes(member.status as MembershipStatus)) {
      throw new ChatForbiddenError();
    }
  }

  /**
   * A page of history in chronological order. `before` is the id of the oldest
   * message the client already has; omit it for the latest messages.
   */
  public async getHistory(
    leagueId: string,
    userId: string,
    options: { before?: string; limit?: number } = {}
  ): Promise<ChatHistoryPage> {
    await this.assertCanAccess(leagueId, userId);
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_HISTORY_LIMIT), MAX_HISTORY_LIMIT);

    let cursorFilter = {};
    if (options.before) {
      const cursor = await this.db.leagueChatMessage.findFirst({
        where: { id: options.before, leagueId },
        select: { id: true, createdAt: true },
      });
      if (!cursor) {
        throw new ChatValidationError("Unknown message cursor");
      }
      cursorFilter = {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      };
    }

    const rows = await this.db.leagueChatMessage.findMany({
      where: { leagueId, ...cursorFilter },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { user: { select: { username: true } } },
    });

    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map(toDto), hasMore };
  }

  /** Validates, rate limits, persists and broadcasts a message. */
  public async postMessage(leagueId: string, userId: string, rawBody: unknown): Promise<ChatMessageDto> {
    const body = sanitizeMessageBody(rawBody);
    await this.assertCanAccess(leagueId, userId);

    const retryAfterMs = this.limiter.consume(`${userId}:${leagueId}`);
    if (retryAfterMs > 0) {
      throw new ChatRateLimitError(retryAfterMs);
    }

    const row = await this.db.leagueChatMessage.create({
      data: { leagueId, userId, body },
      include: { user: { select: { username: true } } },
    });

    const message = toDto(row);
    this.hub.publish(message);
    return message;
  }
}

export const chatService = new ChatService();
