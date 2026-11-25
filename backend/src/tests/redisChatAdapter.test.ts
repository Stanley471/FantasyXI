import { setAccountStatusResolver } from "../services/privacy/accountStatus.js";
setAccountStatusResolver(() => false); // Active-account fixture for this isolated unit suite.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import WebSocket from "ws";
import type { PrismaClient } from "@prisma/client";
import {
  ChatHub,
  ChatRateLimiter,
  ChatService,
  type ChatMessageDto,
} from "../services/chat/chatService.js";
import {
  RedisChatAdapter,
  getLeagueChatChannel,
  parseLeagueIdFromChannel,
  type IRedisPubSubClient,
} from "../services/chat/redisChatAdapter.js";
import { attachChatSocketServer } from "../realtime/chatSocketServer.js";
import { signAccessToken } from "../config/jwt.js";
import { MembershipStatus } from "../types/index.js";

/**
 * Shared mock Redis pub/sub broker simulating a Redis server.
 */
class MockRedisBroker extends EventEmitter {
  public channels = new Map<string, Set<MockRedisPubSubClient>>();

  subscribe(client: MockRedisPubSubClient, channel: string): void {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(client);
  }

  unsubscribe(client: MockRedisPubSubClient, channel: string): void {
    const subs = this.channels.get(channel);
    if (subs) {
      subs.delete(client);
      if (subs.size === 0) {
        this.channels.delete(channel);
      }
    }
  }

  publish(channel: string, message: string): number {
    const subs = this.channels.get(channel);
    if (!subs) return 0;
    for (const client of subs) {
      setImmediate(() => {
        client.emit("message", channel, message);
      });
    }
    return subs.size;
  }

  getSubscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

class MockRedisPubSubClient extends EventEmitter implements IRedisPubSubClient {
  public status = "ready";
  public publishedMessages: Array<{ channel: string; message: string }> = [];

  constructor(public readonly broker: MockRedisBroker) {
    super();
  }

  async publish(channel: string, message: string): Promise<number> {
    this.publishedMessages.push({ channel, message });
    return this.broker.publish(channel, message);
  }

  async subscribe(...channels: string[]): Promise<string> {
    for (const ch of channels) {
      this.broker.subscribe(this, ch);
    }
    return "OK";
  }

  async unsubscribe(...channels: string[]): Promise<string> {
    for (const ch of channels) {
      this.broker.unsubscribe(this, ch);
    }
    return "OK";
  }

  async quit(): Promise<string> {
    this.removeAllListeners();
    return "OK";
  }

  disconnect(): void {
    this.removeAllListeners();
  }
}

// In-memory mock DB
function createMockDb() {
  const leagues = [{ id: "league-redis-1", creatorId: "creator" }];
  const members = [
    { leagueId: "league-redis-1", userId: "user-alpha", status: MembershipStatus.ACTIVE },
    { leagueId: "league-redis-1", userId: "user-beta", status: MembershipStatus.ACTIVE },
  ];
  const messages: Array<{
    id: string;
    leagueId: string;
    userId: string;
    body: string;
    createdAt: Date;
    user: { username: string };
  }> = [];

  return {
    league: {
      findUnique: async ({ where }: any) => leagues.find((l) => l.id === where.id) ?? null,
    },
    leagueMember: {
      findUnique: async ({ where }: any) =>
        members.find(
          (m) =>
            m.leagueId === where.leagueId_userId.leagueId &&
            m.userId === where.leagueId_userId.userId
        ) ?? null,
    },
    leagueChatMessage: {
      create: async ({ data }: any) => {
        const row = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          leagueId: data.leagueId,
          userId: data.userId,
          body: data.body,
          createdAt: new Date(),
          user: { username: data.userId },
        };
        messages.push(row);
        return row;
      },
      findMany: async () => messages,
    },
  };
}

function openSocket(
  url: string,
  token: string
): Promise<{ ws: WebSocket; readyFrame: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    });
    ws.on("message", function onFirst(data) {
      try {
        const frame = JSON.parse(data.toString());
        if (frame.type === "ready") {
          ws.off("message", onFirst);
          resolve({ ws, readyFrame: frame });
        }
      } catch (err) {
        reject(err);
      }
    });
    ws.on("error", reject);
  });
}

function waitForFrame(ws: WebSocket, predicate: (frame: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const handler = (data: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(data.toString());
        if (predicate(frame)) {
          ws.off("message", handler);
          resolve(frame);
        }
      } catch {}
    };
    ws.on("message", handler);
  });
}

describe("RedisChatAdapter - Horizontal WebSocket Chat Clustering", () => {
  it("formats channel names correctly and extracts league ids", () => {
    assert.equal(getLeagueChatChannel("123"), "league:chat:123");
    assert.equal(parseLeagueIdFromChannel("league:chat:123"), "123");
    assert.equal(parseLeagueIdFromChannel("other:channel"), null);
  });

  it("relays messages across two distinct server instances using Redis pub/sub", async () => {
    const broker = new MockRedisBroker();

    // Instance A setup
    const dbA = createMockDb();
    const hubA = new ChatHub();
    const serviceA = new ChatService(
      dbA as unknown as PrismaClient,
      hubA,
      new ChatRateLimiter(100)
    );
    const pubA = new MockRedisPubSubClient(broker);
    const subA = new MockRedisPubSubClient(broker);
    const adapterA = new RedisChatAdapter({
      instanceId: "inst-A",
      publisher: pubA,
      subscriber: subA,
      enabled: true,
    });
    adapterA.attach(hubA);

    const appA = express();
    const serverA = createServer(appA);
    const socketServerA = attachChatSocketServer(serverA, {
      service: serviceA,
      allowedOrigins: ["http://localhost:3000"],
    });

    // Instance B setup
    const dbB = createMockDb();
    const hubB = new ChatHub();
    const serviceB = new ChatService(
      dbB as unknown as PrismaClient,
      hubB,
      new ChatRateLimiter(100)
    );
    const pubB = new MockRedisPubSubClient(broker);
    const subB = new MockRedisPubSubClient(broker);
    const adapterB = new RedisChatAdapter({
      instanceId: "inst-B",
      publisher: pubB,
      subscriber: subB,
      enabled: true,
    });
    adapterB.attach(hubB);

    const appB = express();
    const serverB = createServer(appB);
    const socketServerB = attachChatSocketServer(serverB, {
      service: serviceB,
      allowedOrigins: ["http://localhost:3000"],
    });

    await new Promise<void>((res) => serverA.listen(0, res));
    await new Promise<void>((res) => serverB.listen(0, res));

    const portA = (serverA.address() as AddressInfo).port;
    const portB = (serverB.address() as AddressInfo).port;

    const tokenAlpha = signAccessToken({ userId: "user-alpha", email: "alpha@example.com" });
    const tokenBeta = signAccessToken({ userId: "user-beta", email: "beta@example.com" });

    // Connect Client 1 to Instance A
    const { ws: clientA } = await openSocket(
      `ws://127.0.0.1:${portA}/api/v1/leagues/league-redis-1/chat/ws`,
      tokenAlpha
    );

    // Connect Client 2 to Instance B
    const { ws: clientB } = await openSocket(
      `ws://127.0.0.1:${portB}/api/v1/leagues/league-redis-1/chat/ws`,
      tokenBeta
    );

    // Both instances should have subscribed to Redis channel
    const channelName = "league:chat:league-redis-1";
    assert.equal(broker.getSubscriberCount(channelName), 2);

    // Track messages received on Client B
    const receivedOnBPromise = waitForFrame(
      clientB,
      (f) => f.type === "message" && f.message?.body === "Hello from Instance A!"
    );

    // Post message from Client A on Instance A
    clientA.send(
      JSON.stringify({
        type: "message",
        body: "Hello from Instance A!",
        clientId: "cid-1",
      })
    );

    // Client A should receive ack
    const ack = await waitForFrame(clientA, (f) => f.type === "ack");
    assert.equal(ack.clientId, "cid-1");
    assert.equal(ack.message.body, "Hello from Instance A!");

    // Client B on Instance B should receive the broadcast from Redis pub/sub
    const receivedOnB = await receivedOnBPromise;
    assert.equal(receivedOnB.message.body, "Hello from Instance A!");
    assert.equal(receivedOnB.message.userId, "user-alpha");

    // Clean up
    clientA.close();
    clientB.close();
    await socketServerA.close();
    await socketServerB.close();
    await adapterA.close();
    await adapterB.close();
    await new Promise<void>((res) => serverA.close(() => res()));
    await new Promise<void>((res) => serverB.close(() => res()));
  });

  it("unsubscribes from Redis channel when all local clients disconnect", async () => {
    const broker = new MockRedisBroker();
    const hub = new ChatHub();
    const pub = new MockRedisPubSubClient(broker);
    const sub = new MockRedisPubSubClient(broker);
    const adapter = new RedisChatAdapter({
      instanceId: "inst-cleanup",
      publisher: pub,
      subscriber: sub,
      enabled: true,
    });
    adapter.attach(hub);

    const channel = "league:chat:league-clean-1";
    assert.equal(broker.getSubscriberCount(channel), 0);

    // First subscriber joins
    const unsub1 = hub.subscribe("league-clean-1", () => {});
    // Give event loop tick for async subscribe
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(broker.getSubscriberCount(channel), 1);
    assert.deepEqual(adapter.getSubscribedChannels(), [channel]);

    // Second subscriber joins same league
    const unsub2 = hub.subscribe("league-clean-1", () => {});
    await new Promise((r) => setTimeout(r, 10));
    // Redis subscription count remains 1 for this process
    assert.equal(broker.getSubscriberCount(channel), 1);

    // First subscriber leaves
    unsub1();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(broker.getSubscriberCount(channel), 1);

    // Second subscriber leaves - last listener in process
    unsub2();
    await new Promise((r) => setTimeout(r, 10));
    // Should now be unsubscribed
    assert.equal(broker.getSubscriberCount(channel), 0);
    assert.deepEqual(adapter.getSubscribedChannels(), []);

    await adapter.close();
  });

  it("gracefully degrades to local broadcast when Redis publish fails", async () => {
    const broker = new MockRedisBroker();
    const hub = new ChatHub();

    // Faulty publisher that throws connection error
    const faultyPub: IRedisPubSubClient = {
      publish: async () => {
        throw new Error("ECONNREFUSED - Redis offline");
      },
      subscribe: async () => {},
      unsubscribe: async () => {},
      on: () => faultyPub,
    };
    const sub = new MockRedisPubSubClient(broker);

    const adapter = new RedisChatAdapter({
      instanceId: "inst-fallback",
      publisher: faultyPub,
      subscriber: sub,
      enabled: true,
    });
    adapter.attach(hub);

    let localReceived: ChatMessageDto | null = null;
    hub.subscribe("league-fail-1", (msg) => {
      localReceived = msg;
    });

    const testMsg: ChatMessageDto = {
      id: "msg-local-1",
      leagueId: "league-fail-1",
      userId: "user-1",
      username: "user-1",
      body: "Test message despite Redis error",
      createdAt: new Date().toISOString(),
    };

    // Should not throw
    assert.doesNotThrow(() => {
      hub.publish(testMsg);
    });

    // Local client still received it
    assert.ok(localReceived);
    assert.equal((localReceived as ChatMessageDto).body, "Test message despite Redis error");

    await adapter.close();
  });

  it("suppresses self-echo messages received back from Redis", async () => {
    const broker = new MockRedisBroker();
    const hub = new ChatHub();
    const pub = new MockRedisPubSubClient(broker);
    const sub = new MockRedisPubSubClient(broker);

    const adapter = new RedisChatAdapter({
      instanceId: "inst-dedup",
      publisher: pub,
      subscriber: sub,
      enabled: true,
    });
    adapter.attach(hub);

    let deliveryCount = 0;
    hub.subscribe("league-dedup-1", () => {
      deliveryCount++;
    });

    const testMsg: ChatMessageDto = {
      id: "msg-dedup-1",
      leagueId: "league-dedup-1",
      userId: "user-1",
      username: "user-1",
      body: "Testing deduplication",
      createdAt: new Date().toISOString(),
    };

    // Publish from this instance (increments deliveryCount once locally)
    hub.publish(testMsg);
    assert.equal(deliveryCount, 1);

    // Simulate Redis echo delivered back to this instance with same instanceId
    adapter.handleIncomingMessage(
      "league:chat:league-dedup-1",
      JSON.stringify({
        originInstanceId: "inst-dedup",
        message: testMsg,
        timestamp: Date.now(),
      })
    );

    // deliveryCount must still be 1 (self-echo ignored)
    assert.equal(deliveryCount, 1);

    // Simulate message from another instance
    adapter.handleIncomingMessage(
      "league:chat:league-dedup-1",
      JSON.stringify({
        originInstanceId: "inst-other",
        message: { ...testMsg, id: "msg-dedup-2" },
        timestamp: Date.now(),
      })
    );

    // deliveryCount must now be 2
    assert.equal(deliveryCount, 2);

    await adapter.close();
  });
});
