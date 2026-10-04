import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import WebSocket from "ws";
import type { PrismaClient } from "@prisma/client";
import {
  ChatHub,
  ChatRateLimiter,
  ChatService,
  chatService,
  MAX_MESSAGE_LENGTH,
  sanitizeMessageBody,
  type ChatMessageDto,
} from "../services/chat/chatService.js";
import { attachChatSocketServer, CloseCode } from "../realtime/chatSocketServer.js";
import leagueRoutes from "../routes/league.routes.js";
import { signAccessToken } from "../config/jwt.js";
import { MembershipStatus } from "../types/index.js";

// ------------------------------------------------------------
// In-memory database
// ------------------------------------------------------------

const USERS: Record<string, string> = {
  creator: "gaffer",
  alice: "alice",
  bob: "bob",
  pending: "newbie",
  refunded: "leaver",
  outsider: "stranger",
};

function createChatDb(clock: () => Date = () => new Date()) {
  const leagues = [
    { id: "league-1", creatorId: "creator" },
    { id: "league-2", creatorId: "creator" },
  ];
  const members = [
    { leagueId: "league-1", userId: "alice", status: MembershipStatus.ACTIVE },
    { leagueId: "league-1", userId: "bob", status: MembershipStatus.ACTIVE },
    { leagueId: "league-1", userId: "pending", status: MembershipStatus.PENDING },
    { leagueId: "league-1", userId: "refunded", status: MembershipStatus.REFUNDED },
    { leagueId: "league-2", userId: "alice", status: MembershipStatus.ACTIVE },
  ];
  const messages: Array<{ id: string; leagueId: string; userId: string; body: string; createdAt: Date }> = [];
  const withUser = (m: (typeof messages)[number]) => ({ ...m, user: { username: USERS[m.userId] } });

  const matches = (m: (typeof messages)[number], where: any): boolean =>
    m.leagueId === where.leagueId &&
    (where.id === undefined || m.id === where.id) &&
    (!where.OR ||
      where.OR.some(
        (c: any) =>
          (c.createdAt?.lt && m.createdAt < c.createdAt.lt) ||
          (c.createdAt instanceof Date && m.createdAt.getTime() === c.createdAt.getTime() && m.id < c.id.lt)
      ));

  const db = {
    messages,
    league: {
      findUnique: async ({ where }: any) => leagues.find((l) => l.id === where.id) ?? null,
    },
    leagueMember: {
      findUnique: async ({ where }: any) =>
        members.find(
          (m) => m.leagueId === where.leagueId_userId.leagueId && m.userId === where.leagueId_userId.userId
        ) ?? null,
    },
    leagueChatMessage: {
      create: async ({ data }: any) => {
        const row = { id: randomUUID(), createdAt: clock(), ...data };
        messages.push(row);
        return withUser(row);
      },
      findFirst: async ({ where }: any) => messages.find((m) => matches(m, where)) ?? null,
      findMany: async ({ where, take }: any) =>
        messages
          .filter((m) => matches(m, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, take)
          .map(withUser),
    },
  };
  return db;
}

function createService(options: { clock?: () => Date; limiter?: ChatRateLimiter } = {}) {
  const db = createChatDb(options.clock);
  const service = new ChatService(db as unknown as PrismaClient, new ChatHub(), options.limiter ?? new ChatRateLimiter(1000));
  return { db, service };
}

// ------------------------------------------------------------
// Unit tests
// ------------------------------------------------------------

describe("Chat message validation", () => {
  it("trims, normalises newlines and strips control characters", () => {
    assert.equal(sanitizeMessageBody("  What a finish!  "), "What a finish!");
    assert.equal(sanitizeMessageBody("line one\r\nline two"), "line one\nline two");
    assert.equal(sanitizeMessageBody("too\n\n\n\n\nmany gaps"), "too\n\nmany gaps");
    assert.equal(sanitizeMessageBody("bell\u0007 and\u0000 null"), "bell and null");
  });

  it("keeps markup as plain text (it is rendered as text, never as HTML)", () => {
    assert.equal(sanitizeMessageBody("<b>bold</b>"), "<b>bold</b>");
  });

  it("rejects empty, non-text and over-long messages", () => {
    for (const raw of ["", "   \n  ", "\u0000", undefined, 42, { text: "hi" }]) {
      assert.throws(() => sanitizeMessageBody(raw), { name: "ChatValidationError" }, String(raw));
    }
    assert.throws(() => sanitizeMessageBody("x".repeat(MAX_MESSAGE_LENGTH + 1)), { name: "ChatValidationError" });
    assert.equal(sanitizeMessageBody("x".repeat(MAX_MESSAGE_LENGTH)).length, MAX_MESSAGE_LENGTH);
  });

  it("counts emoji as single characters", () => {
    assert.doesNotThrow(() => sanitizeMessageBody("⚽".repeat(MAX_MESSAGE_LENGTH)));
  });
});

describe("Chat rate limiter", () => {
  it("allows a burst up to the limit, then asks the sender to wait", () => {
    let now = 0;
    const limiter = new ChatRateLimiter(3, 10_000, () => now);
    assert.deepEqual([limiter.consume("u:l"), limiter.consume("u:l"), limiter.consume("u:l")], [0, 0, 0]);

    now = 4_000;
    assert.equal(limiter.consume("u:l"), 6_000);
    // Other users and leagues are unaffected
    assert.equal(limiter.consume("u:other"), 0);

    now = 10_000;
    assert.equal(limiter.consume("u:l"), 0);
  });
});

describe("Chat hub", () => {
  it("delivers only to subscribers of the same league and stops after unsubscribe", () => {
    const hub = new ChatHub();
    const received: string[] = [];
    const stop = hub.subscribe("league-1", (m) => received.push(`a:${m.body}`));
    hub.subscribe("league-2", (m) => received.push(`b:${m.body}`));

    const message = { id: "1", leagueId: "league-1", userId: "u", username: "u", body: "hi", createdAt: "" };
    hub.publish(message);
    stop();
    hub.publish({ ...message, body: "again" });

    assert.deepEqual(received, ["a:hi"]);
    assert.equal(hub.subscriberCount("league-1"), 0);
  });

  it("keeps delivering when one listener throws", () => {
    const hub = new ChatHub();
    const received: string[] = [];
    const errorLog = mock.method(console, "error", () => {});
    hub.subscribe("league-1", () => {
      throw new Error("socket gone");
    });
    hub.subscribe("league-1", (m) => received.push(m.body));

    hub.publish({ id: "1", leagueId: "league-1", userId: "u", username: "u", body: "still here", createdAt: "" });

    assert.deepEqual(received, ["still here"]);
    errorLog.mock.restore();
  });
});

describe("ChatService", () => {
  it("lets the creator and pending or active members in, and keeps everyone else out", async () => {
    const { service } = createService();
    for (const userId of ["creator", "alice", "pending"]) {
      await assert.doesNotReject(service.assertCanAccess("league-1", userId), userId);
    }
    for (const userId of ["refunded", "outsider"]) {
      await assert.rejects(service.assertCanAccess("league-1", userId), { name: "ChatForbiddenError" }, userId);
    }
    await assert.rejects(service.assertCanAccess("missing", "alice"), { name: "ChatNotFoundError" });
  });

  it("persists and broadcasts a posted message", async () => {
    const { db, service } = createService();
    const received: ChatMessageDto[] = [];
    service.hub.subscribe("league-1", (m) => received.push(m));

    const message = await service.postMessage("league-1", "alice", "  Your defence is leaking again 😂 ");

    assert.equal(message.body, "Your defence is leaking again 😂");
    assert.equal(message.username, "alice");
    assert.equal(db.messages.length, 1);
    assert.deepEqual(received, [message]);
  });

  it("does not persist messages from non-members or invalid bodies", async () => {
    const { db, service } = createService();
    await assert.rejects(service.postMessage("league-1", "outsider", "hello"), { name: "ChatForbiddenError" });
    await assert.rejects(service.postMessage("league-1", "alice", "   "), { name: "ChatValidationError" });
    assert.equal(db.messages.length, 0);
  });

  it("rate limits per user and league", async () => {
    const { service } = createService({ limiter: new ChatRateLimiter(2, 60_000) });
    await service.postMessage("league-1", "alice", "one");
    await service.postMessage("league-1", "alice", "two");
    await assert.rejects(service.postMessage("league-1", "alice", "three"), (error: any) => {
      assert.equal(error.name, "ChatRateLimitError");
      assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 60_000);
      return true;
    });
    await assert.doesNotReject(service.postMessage("league-1", "bob", "my turn"));
  });

  it("pages history newest-first and returns each page in chronological order", async () => {
    let t = Date.UTC(2026, 8, 1, 12);
    const { service } = createService({ clock: () => new Date((t += 1000)) });
    for (let i = 1; i <= 7; i++) await service.postMessage("league-1", i % 2 ? "alice" : "bob", `message ${i}`);
    await service.postMessage("league-2", "alice", "other league");

    const latest = await service.getHistory("league-1", "bob", { limit: 3 });
    assert.deepEqual(latest.messages.map((m) => m.body), ["message 5", "message 6", "message 7"]);
    assert.equal(latest.hasMore, true);

    const older = await service.getHistory("league-1", "bob", { limit: 3, before: latest.messages[0].id });
    assert.deepEqual(older.messages.map((m) => m.body), ["message 2", "message 3", "message 4"]);

    const oldest = await service.getHistory("league-1", "bob", { limit: 3, before: older.messages[0].id });
    assert.deepEqual(oldest.messages.map((m) => m.body), ["message 1"]);
    assert.equal(oldest.hasMore, false);
  });

  it("does not skip or repeat messages that share a timestamp", async () => {
    const { service } = createService({ clock: () => new Date(Date.UTC(2026, 8, 1)) });
    for (let i = 1; i <= 5; i++) await service.postMessage("league-1", "alice", `same instant ${i}`);

    const seen: string[] = [];
    let before: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = await service.getHistory("league-1", "alice", { limit: 2, before });
      seen.unshift(...page.messages.map((m) => m.id));
      before = page.messages[0]?.id;
      hasMore = page.hasMore;
    }
    assert.equal(new Set(seen).size, 5);
  });

  it("clamps the page size and rejects unknown cursors and outsiders", async () => {
    const { service } = createService();
    await service.postMessage("league-1", "alice", "hello");
    assert.equal((await service.getHistory("league-1", "alice", { limit: 10_000 })).messages.length, 1);
    await assert.rejects(service.getHistory("league-1", "alice", { before: "nope" }), { name: "ChatValidationError" });
    await assert.rejects(service.getHistory("league-1", "outsider"), { name: "ChatForbiddenError" });
  });
});

// ------------------------------------------------------------
// WebSocket + REST integration over a real HTTP server
// ------------------------------------------------------------

const ORIGIN = "http://localhost:3000";
const tokenFor = (userId: string) => signAccessToken({ userId, email: `${userId}@example.com`, username: USERS[userId] });

interface TestClient {
  socket: WebSocket;
  frames: any[];
  next(predicate?: (frame: any) => boolean, timeoutMs?: number): Promise<any>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(url: string, origin = ORIGIN): TestClient {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  const frames: any[] = [];
  const waiters: Array<{ predicate: (f: any) => boolean; resolve: (f: any) => void }> = [];
  // Each next() consumes the first matching frame that no earlier next() has consumed
  const consumed = new Set<number>();

  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    frames.push(frame);
    const waiter = waiters.find((w) => w.predicate(frame));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      consumed.add(frames.length - 1);
      waiter.resolve(frame);
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  socket.on("error", () => {});

  return {
    socket,
    frames,
    closed,
    next(predicate = () => true, timeoutMs = 2000) {
      const index = frames.findIndex((f, i) => !consumed.has(i) && predicate(f));
      if (index >= 0) {
        consumed.add(index);
        return Promise.resolve(frames[index]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for frame")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

async function openAndAuth(url: string, userId: string): Promise<TestClient> {
  const client = connect(url);
  await new Promise<void>((resolve, reject) => {
    client.socket.once("open", () => resolve());
    client.socket.once("error", reject);
  });
  client.socket.send(JSON.stringify({ type: "auth", token: tokenFor(userId) }));
  const ready = await client.next((f) => f.type === "ready" || f.type === "error");
  assert.equal(ready.type, "ready", JSON.stringify(ready));
  return client;
}

describe("League chat over WebSockets", () => {
  let server: Server;
  let baseHttp: string;
  let baseWs: string;
  let socketServer: ReturnType<typeof attachChatSocketServer>;
  let service: ChatService;
  const clients: TestClient[] = [];

  const track = (client: TestClient) => {
    clients.push(client);
    return client;
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/leagues", leagueRoutes);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    baseHttp = `http://127.0.0.1:${port}/api/v1/leagues`;
    baseWs = `ws://127.0.0.1:${port}/api/v1/leagues`;
  });

  beforeEach(() => {
    service = createService({ limiter: new ChatRateLimiter(3, 60_000) }).service;
    socketServer?.close();
    socketServer = attachChatSocketServer(server, { service, allowedOrigins: [ORIGIN], authTimeoutMs: 200 });
    // REST endpoints use the same in-memory service
    mock.restoreAll();
    mock.method(chatService, "getHistory", (...args: Parameters<ChatService["getHistory"]>) => service.getHistory(...args));
    mock.method(chatService, "postMessage", (...args: Parameters<ChatService["postMessage"]>) => service.postMessage(...args));
  });

  after(async () => {
    for (const client of clients) client.socket.terminate();
    await socketServer?.close();
    mock.restoreAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("broadcasts a message to every connected member in real time", async () => {
    const alice = track(await openAndAuth(`${baseWs}/league-1/chat/ws`, "alice"));
    const bob = track(await openAndAuth(`${baseWs}/league-1/chat/ws`, "bob"));

    alice.socket.send(JSON.stringify({ type: "message", body: "Bottled it again, Bob", clientId: "c-1" }));

    const ack = await alice.next((f) => f.type === "ack");
    const atBob = await bob.next((f) => f.type === "message");
    const atAlice = await alice.next((f) => f.type === "message");

    assert.equal(ack.clientId, "c-1");
    assert.equal(atBob.message.body, "Bottled it again, Bob");
    assert.equal(atBob.message.username, "alice");
    assert.deepEqual(atAlice.message, atBob.message);
    assert.equal(ack.message.id, atBob.message.id);
  });

  it("persists history so it survives a page reload", async () => {
    const alice = track(await openAndAuth(`${baseWs}/league-1/chat/ws`, "alice"));
    alice.socket.send(JSON.stringify({ type: "message", body: "first" }));
    await alice.next((f) => f.type === "ack");
    alice.socket.send(JSON.stringify({ type: "message", body: "second" }));
    await alice.next((f) => f.type === "ack");
    alice.socket.close();

    // "Reload": fetch history over HTTP as another member
    const res = await fetch(`${baseHttp}/league-1/chat/messages`, {
      headers: { Authorization: `Bearer ${tokenFor("bob")}` },
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body.data.map((m: ChatMessageDto) => m.body), ["first", "second"]);
    assert.deepEqual(body.meta, { hasMore: false });
  });

  it("broadcasts messages posted through the HTTP fallback", async () => {
    const bob = track(await openAndAuth(`${baseWs}/league-1/chat/ws`, "bob"));

    const res = await fetch(`${baseHttp}/league-1/chat/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor("creator")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Welcome to the league" }),
    });

    assert.equal(res.status, 201);
    const frame = await bob.next((f) => f.type === "message");
    assert.equal(frame.message.username, "gaffer");
  });

  it("isolates leagues from each other", async () => {
    const inLeague1 = track(await openAndAuth(`${baseWs}/league-1/chat/ws`, "alice"));
    const inLeague2 = track(await openAndAuth(`${baseWs}/league-2/chat/ws`, "alice"));

    inLeague2.socket.send(JSON.stringify({ type: "message", body: "league two only" }));
    await inLeague2.next((f) => f.type === "message");
    inLeague1.socket.send(JSON.stringify({ type: "message", body: "league one only" }));
    await inLeague1.next((f) => f.type === "message");

    assert.deepEqual(
      inLeague1.frames.filter((f) => f.type === "message").map((f) => f.message.body),
      ["league one only"]
    );
  });

  it("reports invalid and rate-limited messages without dropping the connection", async () => {
    const alice = track(await openAndAuth(`${baseWs}/league-1/chat/ws`, "alice"));

    alice.socket.send(JSON.stringify({ type: "message", body: "   ", clientId: "empty" }));
    const invalid = await alice.next((f) => f.type === "error");
    assert.deepEqual([invalid.code, invalid.clientId], ["invalid_message", "empty"]);

    for (let i = 0; i < 3; i++) {
      alice.socket.send(JSON.stringify({ type: "message", body: `spam ${i}` }));
      await alice.next((f) => f.type === "ack");
    }
    alice.socket.send(JSON.stringify({ type: "message", body: "one too many", clientId: "c-4" }));
    const limited = await alice.next((f) => f.type === "error");
    assert.deepEqual([limited.code, limited.clientId], ["rate_limited", "c-4"]);
    assert.ok(limited.retryAfterMs > 0);

    alice.socket.send("not json");
    assert.equal((await alice.next((f) => f.type === "error")).code, "bad_request");
    assert.equal(alice.socket.readyState, WebSocket.OPEN);
  });

  it("rejects an invalid token", async () => {
    const client = track(connect(`${baseWs}/league-1/chat/ws`));
    await new Promise((resolve) => client.socket.once("open", resolve));
    client.socket.send(JSON.stringify({ type: "auth", token: "not-a-jwt" }));
    assert.equal((await client.closed).code, CloseCode.UNAUTHORIZED);
  });

  it("rejects a message sent before authenticating", async () => {
    const client = track(connect(`${baseWs}/league-1/chat/ws`));
    await new Promise((resolve) => client.socket.once("open", resolve));
    client.socket.send(JSON.stringify({ type: "message", body: "sneaky" }));
    assert.equal((await client.closed).code, CloseCode.UNAUTHORIZED);
  });

  it("rejects users who are not members and unknown leagues", async () => {
    for (const [league, userId, code] of [
      ["league-1", "outsider", CloseCode.FORBIDDEN],
      ["league-1", "refunded", CloseCode.FORBIDDEN],
      ["missing", "alice", CloseCode.NOT_FOUND],
    ] as const) {
      const client = track(connect(`${baseWs}/${league}/chat/ws`));
      await new Promise((resolve) => client.socket.once("open", resolve));
      client.socket.send(JSON.stringify({ type: "auth", token: tokenFor(userId) }));
      assert.equal((await client.closed).code, code, `${userId} -> ${league}`);
    }
  });

  it("closes connections that never authenticate", async () => {
    const client = track(connect(`${baseWs}/league-1/chat/ws`));
    assert.equal((await client.closed).code, CloseCode.AUTH_TIMEOUT);
  });

  it("refuses upgrades from other origins and unknown paths", async () => {
    const statusOf = (client: TestClient) =>
      new Promise<number>((resolve) => client.socket.once("unexpected-response", (_req, res) => resolve(res.statusCode!)));

    assert.equal(await statusOf(track(connect(`${baseWs}/league-1/chat/ws`, "https://evil.example"))), 403);
    assert.equal(await statusOf(track(connect(`${baseWs.replace("/leagues", "")}/nope`))), 404);
  });

  it("guards the history endpoint", async () => {
    const outsider = await fetch(`${baseHttp}/league-1/chat/messages`, {
      headers: { Authorization: `Bearer ${tokenFor("outsider")}` },
    });
    assert.equal(outsider.status, 403);

    const anonymous = await fetch(`${baseHttp}/league-1/chat/messages`);
    assert.equal(anonymous.status, 401);

    const badLimit = await fetch(`${baseHttp}/league-1/chat/messages?limit=abc`, {
      headers: { Authorization: `Bearer ${tokenFor("alice")}` },
    });
    assert.equal(badLimit.status, 400);
  });
});
