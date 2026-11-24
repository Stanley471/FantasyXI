import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DEPOSIT_CONFIRMED_NOTIFICATION,
  resolveStreamAccounts,
  StellarStreamService,
  type HorizonPaymentRecord,
  type PaymentStreamHandlers,
  type PendingDeposit,
} from "../services/financial/stellarStreamService.js";
import { UserNotificationHub } from "../services/notifications/userNotificationHub.js";
import {
  attachNotificationSocketServer,
  NOTIFICATION_SOCKET_PATH,
} from "../realtime/notificationSocketServer.js";
import { attachChatSocketServer } from "../realtime/chatSocketServer.js";
import { signAccessToken } from "../config/jwt.js";

const ESCROW = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const OTHER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const hash = (n: number) => n.toString(16).padStart(64, "b");

function payment(n: number, overrides: Partial<HorizonPaymentRecord> = {}): HorizonPaymentRecord {
  return {
    id: String(n),
    type: "payment",
    paging_token: `pt-${n}`,
    transaction_hash: hash(n),
    transaction_successful: true,
    created_at: new Date().toISOString(),
    to: ESCROW,
    amount: "10.0000000",
    ...overrides,
  };
}

/** Fake Horizon: records each connection so tests can push records or drop it. */
function createFakeHorizon() {
  const connections: Array<{ account: string; cursor: string; handlers: PaymentStreamHandlers; closed: boolean }> = [];
  const streamFactory = (account: string, cursor: string, handlers: PaymentStreamHandlers) => {
    const connection = { account, cursor, handlers, closed: false };
    connections.push(connection);
    return () => {
      connection.closed = true;
    };
  };
  return { connections, streamFactory };
}

function lookupFor(deposits: Record<string, PendingDeposit>) {
  return { findPendingDeposit: async (txHash: string) => deposits[txHash] ?? null };
}

describe("StellarStreamService (#557)", () => {
  it("publishes deposit.confirmed to the depositor when a streamed payment matches a pending deposit", async () => {
    const hub = new UserNotificationHub();
    const received: any[] = [];
    hub.subscribe("user-1", (n) => received.push(n));
    const horizon = createFakeHorizon();
    const service = new StellarStreamService({
      accounts: [ESCROW],
      lookup: lookupFor({ [hash(1)]: { userId: "user-1", leagueId: "league-1", amount: "10.00" } }),
      streamFactory: horizon.streamFactory,
      hub,
      logger: quiet,
    });
    service.start();
    assert.equal(horizon.connections[0].cursor, "now");

    assert.equal(await service.handleRecord(ESCROW, payment(1)), true);
    assert.equal(received.length, 1);
    assert.equal(received[0].type, DEPOSIT_CONFIRMED_NOTIFICATION);
    assert.equal(received[0].data.txHash, hash(1));
    assert.equal(received[0].data.leagueId, "league-1");
    assert.equal(received[0].data.amount, "10.0000000");
    service.stop();
  });

  it("ignores unmatched, misdirected, failed and non-payment records, and does not notify twice", async () => {
    const hub = new UserNotificationHub();
    const received: unknown[] = [];
    hub.subscribe("user-1", (n) => received.push(n));
    const service = new StellarStreamService({
      accounts: [ESCROW],
      lookup: lookupFor({ [hash(1)]: { userId: "user-1", leagueId: "l", amount: "10" } }),
      streamFactory: createFakeHorizon().streamFactory,
      hub,
      logger: quiet,
    });
    service.start();

    assert.equal(await service.handleRecord(ESCROW, payment(2)), false); // no pending deposit
    assert.equal(await service.handleRecord(ESCROW, payment(1, { to: OTHER })), false);
    assert.equal(await service.handleRecord(ESCROW, payment(1, { transaction_successful: false })), false);
    assert.equal(await service.handleRecord(ESCROW, payment(1, { type: "create_account" })), false);
    assert.equal(received.length, 0);

    assert.equal(await service.handleRecord(ESCROW, payment(1)), true);
    assert.equal(await service.handleRecord(ESCROW, payment(1)), false); // replay
    assert.equal(received.length, 1);
    service.stop();
  });

  it("reconnects with exponential backoff and resumes from the last paging token", async () => {
    const horizon = createFakeHorizon();
    const service = new StellarStreamService({
      accounts: [ESCROW],
      lookup: lookupFor({}),
      streamFactory: horizon.streamFactory,
      hub: new UserNotificationHub(),
      baseBackoffMs: 20,
      maxBackoffMs: 80,
      logger: quiet,
    });
    service.start();
    await service.handleRecord(ESCROW, payment(5));

    horizon.connections[0].handlers.onerror(new Error("sse dropped"));
    assert.equal(horizon.connections[0].closed, true);
    assert.equal(horizon.connections.length, 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(horizon.connections.length, 2);
    assert.equal(horizon.connections[1].cursor, "pt-5");

    // Consecutive failures without a message double the delay: 20ms, then 40ms.
    horizon.connections[1].handlers.onerror(new Error("still down"));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(horizon.connections.length, 2, "second retry must wait longer than the first");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(horizon.connections.length, 3);
    service.stop();
  });

  it("does not reconnect after stop()", async () => {
    const horizon = createFakeHorizon();
    const service = new StellarStreamService({
      accounts: [ESCROW],
      lookup: lookupFor({}),
      streamFactory: horizon.streamFactory,
      hub: new UserNotificationHub(),
      baseBackoffMs: 10,
      logger: quiet,
    });
    service.start();
    horizon.connections[0].handlers.onerror(new Error("drop"));
    service.stop();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(horizon.connections.length, 1);
  });

  it("computes capped exponential delays", () => {
    assert.deepEqual([1, 2, 3, 4, 10].map((n) => StellarStreamService.backoffDelay(n, 1000, 8000)), [
      1000, 2000, 4000, 8000, 8000,
    ]);
  });

  it("resolves only valid escrow accounts from env, falling back to the treasury", () => {
    assert.deepEqual(resolveStreamAccounts({ STELLAR_STREAM_ACCOUNTS: `${ESCROW}, bogus` } as any, OTHER), [ESCROW]);
    assert.deepEqual(resolveStreamAccounts({} as any, OTHER), [OTHER]);
    assert.deepEqual(resolveStreamAccounts({} as any, "not-a-key"), []);
  });
});

describe("Horizon stream to notification WebSocket (#557)", () => {
  const ORIGIN = "http://localhost:3000";
  let server: http.Server;
  let url: string;
  const hub = new UserNotificationHub();
  let notifications: ReturnType<typeof attachNotificationSocketServer>;
  let chat: ReturnType<typeof attachChatSocketServer>;

  before(async () => {
    server = http.createServer();
    chat = attachChatSocketServer(server, { passthroughPaths: [NOTIFICATION_SOCKET_PATH], allowedOrigins: [ORIGIN] });
    notifications = attachNotificationSocketServer(server, { hub, allowedOrigins: [ORIGIN], authTimeoutMs: 500 });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await notifications.close();
    await chat.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers a streamed payment to the frontend socket within 500ms of ledger close", async () => {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`${url}/api/v1/notifications/ws`, { headers: { Origin: ORIGIN } });
      s.once("open", () => resolve(s));
      s.once("error", reject);
    });
    const nextFrame = () =>
      new Promise<any>((resolve) => socket.once("message", (d) => resolve(JSON.parse(d.toString()))));

    const ready = nextFrame();
    socket.send(JSON.stringify({ type: "auth", token: signAccessToken({ userId: "ws-dep", email: "d@x.io", username: "d" }) }));
    assert.deepEqual(await ready, { type: "ready", userId: "ws-dep" });

    const horizon = createFakeHorizon();
    const service = new StellarStreamService({
      accounts: [ESCROW],
      lookup: lookupFor({ [hash(7)]: { userId: "ws-dep", leagueId: "league-7", amount: "25.00" } }),
      streamFactory: horizon.streamFactory,
      hub,
      logger: quiet,
    });
    service.start();

    const ledgerClosedAt = Date.now();
    const frame = nextFrame();
    horizon.connections[0].handlers.onmessage(
      payment(7, { created_at: new Date(ledgerClosedAt).toISOString() })
    );
    const message = await frame;
    const elapsed = Date.now() - ledgerClosedAt;

    assert.equal(message.type, "notification");
    assert.equal(message.notification.type, DEPOSIT_CONFIRMED_NOTIFICATION);
    assert.equal(message.notification.data.txHash, hash(7));
    assert.equal(message.notification.data.leagueId, "league-7");
    assert.ok(elapsed < 500, `dispatch took ${elapsed}ms`);

    service.stop();
    socket.close();
  });
});
