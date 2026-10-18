import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Keypair } from "@stellar/stellar-sdk";
import {
  CoordinatedTransactionStatus,
  TRANSACTION_STATUS_EVENT,
  TransactionCoordinatorService,
  TransactionStatusRpc,
  TransactionValidationError,
  TransactionWebhookPort,
} from "../services/financial/transactionCoordinatorService.js";
import { UserNotificationHub, UserNotification } from "../services/notifications/userNotificationHub.js";
import { AdminAlert, AdminAlertSink } from "../services/notifications/adminAlertNotifier.js";
import { InMemoryEventBus } from "../services/events/eventBus.js";
import { attachNotificationSocketServer } from "../realtime/notificationSocketServer.js";
import { attachChatSocketServer } from "../realtime/chatSocketServer.js";
import { NOTIFICATION_SOCKET_PATH } from "../realtime/notificationSocketServer.js";
import { signAccessToken } from "../config/jwt.js";
import { FinancialService } from "../services/financial/financialService.js";
import { PaymentStatus, TransactionType } from "../types/index.js";
import type { WebhookEndpoint } from "../services/webhooks/webhookDispatcher.js";

const hash = (n: number) => n.toString(16).padStart(64, "a");

/** In-memory stand-in for prisma.coordinatedTransaction (shared across coordinator instances). */
function createDb() {
  const rows = new Map<string, any>();
  const db = {
    rows,
    coordinatedTransaction: {
      upsert: async ({ where, create }: any) => {
        for (const row of rows.values()) if (row.txHash === where.txHash) return { ...row };
        const row = {
          id: randomUUID(),
          attempts: 0,
          ledgerSeq: null,
          lastError: null,
          lastPolledAt: null,
          finalizedAt: null,
          metadata: null,
          ...create,
        };
        rows.set(row.id, row);
        return { ...row };
      },
      findUnique: async ({ where }: any) => {
        for (const row of rows.values()) {
          if ((where.id && row.id === where.id) || (where.txHash && row.txHash === where.txHash)) return { ...row };
        }
        return null;
      },
      findMany: async ({ where, take }: any) =>
        [...rows.values()]
          .filter((r) => r.status === where.status && r.nextPollAt.getTime() <= where.nextPollAt.lte.getTime())
          .sort((a, b) => a.nextPollAt.getTime() - b.nextPollAt.getTime())
          .slice(0, take)
          .map((r) => ({ ...r })),
      // Yields before the compare-and-set so concurrent pollers genuinely race
      updateMany: async ({ where, data }: any) => {
        await new Promise((resolve) => setImmediate(resolve));
        const row = rows.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  return db;
}

/** Scripted Soroban RPC: per-hash response queue (the last response repeats). */
function createRpc(script: Record<string, Array<{ status: string; ledger?: number } | Error>>, latencyMs = 0) {
  const calls: string[] = [];
  const rpc: TransactionStatusRpc = {
    async getTransaction(txHash: string) {
      calls.push(txHash);
      if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      const queue = script[txHash] ?? [{ status: "NOT_FOUND" }];
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next instanceof Error) throw next;
      return {
        ...next,
        resultXdr: next.status === "FAILED" ? { toXDR: () => "AAAAFAILED" } : undefined,
      };
    },
  };
  return { rpc, calls };
}

function createClock(start = new Date("2026-10-17T12:00:00Z")) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function createHarness(options: {
  db?: ReturnType<typeof createDb>;
  script?: Parameters<typeof createRpc>[0];
  latencyMs?: number;
  clock?: ReturnType<typeof createClock>;
  endpoints?: WebhookEndpoint[];
  hub?: UserNotificationHub;
}) {
  const db = options.db ?? createDb();
  const clock = options.clock ?? createClock();
  const { rpc, calls } = createRpc(options.script ?? {}, options.latencyMs);
  const alerts: AdminAlert[] = [];
  const alertSink: AdminAlertSink = {
    notify: async (alert) => {
      alerts.push(alert);
      return { slack: "sent", email: { sent: 0, failed: 0 } };
    },
  };
  const deliveries: Array<{ endpointId: string; event: string; payload: any }> = [];
  const webhooks: TransactionWebhookPort = {
    listEndpoints: () => options.endpoints ?? [],
    dispatch: async (endpoint, event, payload) => {
      deliveries.push({ endpointId: endpoint.id, event, payload });
    },
  };
  const hub = options.hub ?? new UserNotificationHub();
  const bus = new InMemoryEventBus();
  const busEvents: any[] = [];
  bus.subscribe(TRANSACTION_STATUS_EVENT, (payload) => {
    busEvents.push(payload);
  });

  const coordinator = new TransactionCoordinatorService({
    db,
    rpc,
    hub,
    webhooks,
    alerts: alertSink,
    eventBus: bus,
    initialDelayMs: 1_000,
    maxDelayMs: 8_000,
    maxPendingMs: 60_000,
    now: clock.now,
  });
  return { coordinator, db, clock, rpcCalls: calls, alerts, deliveries, hub, busEvents };
}

describe("TransactionCoordinatorService", () => {
  it("validates hashes and tracks each hash only once", async () => {
    const { coordinator, db } = createHarness({});
    await assert.rejects(coordinator.track({ txHash: "not-a-hash", kind: "DEPOSIT" }), TransactionValidationError);
    await assert.rejects(coordinator.track({ txHash: hash(1), kind: "" }), TransactionValidationError);

    const first = await coordinator.track({ txHash: hash(1).toUpperCase(), kind: "DEPOSIT", userId: "u1" });
    const second = await coordinator.track({ txHash: hash(1), kind: "SETTLEMENT", userId: "other" });
    assert.equal(db.rows.size, 1);
    assert.equal(first.id, second.id);
    assert.equal(second.kind, "DEPOSIT", "re-tracking never overwrites the original record");
    assert.equal(first.txHash, hash(1));
    assert.equal(first.status, CoordinatedTransactionStatus.PENDING);
  });

  it("keeps NOT_FOUND transactions pending with exponential backoff", async () => {
    const { coordinator, db, clock, rpcCalls } = createHarness({});
    const tracked = await coordinator.track({ txHash: hash(2), kind: "DEPOSIT" });

    let summary = await coordinator.pollDue();
    assert.deepEqual(summary, { checked: 1, succeeded: 0, failed: 0, dropped: 0, stillPending: 1 });
    let row = db.rows.get(tracked.id);
    assert.equal(row.attempts, 1);
    assert.equal(row.nextPollAt.getTime() - clock.now().getTime(), 1_000);

    // Not due yet: no RPC call
    summary = await coordinator.pollDue();
    assert.equal(summary.checked, 0);
    assert.equal(rpcCalls.length, 1);

    clock.advance(1_000);
    await coordinator.pollDue();
    row = db.rows.get(tracked.id);
    assert.equal(row.attempts, 2);
    assert.equal(row.nextPollAt.getTime() - clock.now().getTime(), 2_000);

    clock.advance(2_000);
    await coordinator.pollDue();
    assert.equal(db.rows.get(tracked.id).nextPollAt.getTime() - clock.now().getTime(), 4_000);

    // Capped at maxDelayMs
    for (let i = 0; i < 4; i++) {
      clock.advance(10_000);
      await coordinator.pollDue();
    }
    assert.equal(db.rows.get(tracked.id).nextPollAt.getTime() - clock.now().getTime(), 8_000);
  });

  it("finalizes SUCCESS and emits to sockets, webhooks, the event bus and kind hooks", async () => {
    const endpoints: WebhookEndpoint[] = [
      { id: "ep-league", url: "https://a", secret: "s", leagueId: "league-1", userId: "x", events: [TRANSACTION_STATUS_EVENT], isActive: true },
      { id: "ep-owner", url: "https://b", secret: "s", leagueId: null, userId: "user-1", events: ["*"], isActive: true },
      { id: "ep-other-league", url: "https://c", secret: "s", leagueId: "league-2", userId: "x", events: [TRANSACTION_STATUS_EVENT], isActive: true },
      { id: "ep-other-event", url: "https://d", secret: "s", leagueId: "league-1", userId: "x", events: ["ping"], isActive: true },
      { id: "ep-inactive", url: "https://e", secret: "s", leagueId: "league-1", userId: "x", events: [TRANSACTION_STATUS_EVENT], isActive: false },
    ];
    const h = createHarness({
      script: { [hash(3)]: [{ status: "NOT_FOUND" }, { status: "SUCCESS", ledger: 4242 }] },
      endpoints,
    });
    const socketFrames: UserNotification[] = [];
    h.hub.subscribe("user-1", (n) => socketFrames.push(n));
    const hookCalls: any[] = [];
    h.coordinator.onFinalized("DEPOSIT", (change) => {
      hookCalls.push(change);
    });
    h.coordinator.onFinalized("SETTLEMENT", () => {
      throw new Error("must not run for deposits");
    });

    const tracked = await h.coordinator.track({
      txHash: hash(3),
      kind: "DEPOSIT",
      userId: "user-1",
      leagueId: "league-1",
      transactionId: "tx-row-1",
    });
    await h.coordinator.pollDue();
    assert.equal(socketFrames.length, 0, "no event while still pending");

    h.clock.advance(1_000);
    const summary = await h.coordinator.pollDue();
    assert.equal(summary.succeeded, 1);

    const row = h.db.rows.get(tracked.id);
    assert.equal(row.status, CoordinatedTransactionStatus.SUCCESS);
    assert.equal(row.ledgerSeq, 4242);
    assert.ok(row.finalizedAt);

    assert.equal(socketFrames.length, 1);
    assert.equal(socketFrames[0].type, TRANSACTION_STATUS_EVENT);
    assert.equal(socketFrames[0].data.status, "SUCCESS");
    assert.equal(socketFrames[0].data.previousStatus, "PENDING");
    assert.deepEqual(h.deliveries.map((d) => d.endpointId).sort(), ["ep-league", "ep-owner"]);
    assert.equal(h.busEvents.length, 1);
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].transactionId, "tx-row-1");
    assert.equal(h.alerts.length, 0);
  });

  it("finalizes FAILED with the on-chain result", async () => {
    const h = createHarness({ script: { [hash(4)]: [{ status: "FAILED", ledger: 99 }] } });
    const frames: UserNotification[] = [];
    h.hub.subscribe("user-4", (n) => frames.push(n));
    const tracked = await h.coordinator.track({ txHash: hash(4), kind: "DEPOSIT", userId: "user-4" });
    const summary = await h.coordinator.pollDue();

    assert.equal(summary.failed, 1);
    const row = h.db.rows.get(tracked.id);
    assert.equal(row.status, CoordinatedTransactionStatus.FAILED);
    assert.match(row.lastError, /failed on-chain.*AAAAFAILED/);
    assert.equal(frames[0].data.status, "FAILED");
  });

  it("marks transactions dropped after the max timeout and alerts an administrator once", async () => {
    const h = createHarness({});
    const tracked = await h.coordinator.track({ txHash: hash(5), kind: "SETTLEMENT", leagueId: "league-5" });

    for (let elapsed = 0; elapsed < 60_000; elapsed += 8_000) {
      await h.coordinator.pollDue();
      h.clock.advance(8_000);
    }
    const summary = await h.coordinator.pollDue();
    assert.equal(summary.dropped, 1);

    const row = h.db.rows.get(tracked.id);
    assert.equal(row.status, CoordinatedTransactionStatus.DROPPED);
    assert.match(row.lastError, /not found on the network/);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0].severity, "critical");
    assert.match(h.alerts[0].text, new RegExp(hash(5)));
    assert.match(h.alerts[0].text, /league-5/);

    // Final rows are never polled or alerted again
    h.clock.advance(60_000);
    assert.equal((await h.coordinator.pollDue()).checked, 0);
    assert.equal(h.alerts.length, 1);
  });

  it("treats transient RPC errors as pending, then confirms", async () => {
    const h = createHarness({
      script: { [hash(6)]: [new Error("socket hang up"), new Error("503"), { status: "SUCCESS", ledger: 7 }] },
    });
    const tracked = await h.coordinator.track({ txHash: hash(6), kind: "DEPOSIT" });

    await h.coordinator.pollDue();
    assert.equal(h.db.rows.get(tracked.id).status, "PENDING");
    assert.match(h.db.rows.get(tracked.id).lastError, /socket hang up/);

    h.clock.advance(1_000);
    await h.coordinator.pollDue();
    h.clock.advance(2_000);
    await h.coordinator.pollDue();
    assert.equal(h.db.rows.get(tracked.id).status, "SUCCESS");
    assert.equal(h.db.rows.get(tracked.id).lastError, null);
  });

  it("resumes tracking long-pending transactions after a backend restart", async () => {
    const db = createDb();
    const clock = createClock();
    const before = createHarness({ db, clock, script: { [hash(7)]: [{ status: "NOT_FOUND" }] } });
    await before.coordinator.track({ txHash: hash(7), kind: "DEPOSIT", userId: "user-7" });
    await before.coordinator.pollDue();
    await before.coordinator.pollDue();
    // ...process restarts: a brand-new coordinator shares only the database
    clock.advance(30_000);
    const after = createHarness({ db, clock, script: { [hash(7)]: [{ status: "SUCCESS", ledger: 1234 }] } });
    const frames: UserNotification[] = [];
    after.hub.subscribe("user-7", (n) => frames.push(n));

    const summary = await after.coordinator.pollDue();
    assert.equal(summary.succeeded, 1);
    const [row] = [...db.rows.values()];
    assert.equal(row.status, "SUCCESS");
    assert.equal(row.attempts, 2, "attempt count carries over across the restart");
    assert.equal(frames.length, 1);
  });

  it("emits a status change only once when several instances poll concurrently", async () => {
    const db = createDb();
    const clock = createClock();
    const hub = new UserNotificationHub();
    const frames: UserNotification[] = [];
    hub.subscribe("user-8", (n) => frames.push(n));
    const script = () => ({ [hash(8)]: [{ status: "SUCCESS", ledger: 5 }] });
    const a = createHarness({ db, clock, hub, script: script() });
    const b = createHarness({ db, clock, hub, script: script() });
    await a.coordinator.track({ txHash: hash(8), kind: "DEPOSIT", userId: "user-8" });

    const [sa, sb] = await Promise.all([a.coordinator.pollDue(), b.coordinator.pollDue()]);
    assert.equal(sa.succeeded + sb.succeeded, 2, "both observe the final status");
    assert.equal(frames.length, 1, "but only one instance emits it");
    assert.equal(a.busEvents.length + b.busEvents.length, 1);
  });

  it("handles a mixed batch under simulated network delay", async () => {
    const h = createHarness({
      latencyMs: 15,
      script: {
        [hash(10)]: [{ status: "NOT_FOUND" }, { status: "NOT_FOUND" }, { status: "SUCCESS", ledger: 10 }],
        [hash(11)]: [{ status: "FAILED", ledger: 11 }],
        [hash(12)]: [{ status: "NOT_FOUND" }],
      },
    });
    for (const n of [10, 11, 12]) await h.coordinator.track({ txHash: hash(n), kind: "DEPOSIT" });

    const totals = { succeeded: 0, failed: 0, dropped: 0 };
    for (let i = 0; i < 20; i++) {
      const s = await h.coordinator.pollDue();
      totals.succeeded += s.succeeded;
      totals.failed += s.failed;
      totals.dropped += s.dropped;
      h.clock.advance(8_000);
    }
    assert.deepEqual(totals, { succeeded: 1, failed: 1, dropped: 1 });
    const byHash = new Map([...h.db.rows.values()].map((r) => [r.txHash, r.status]));
    assert.equal(byHash.get(hash(10)), "SUCCESS");
    assert.equal(byHash.get(hash(11)), "FAILED");
    assert.equal(byHash.get(hash(12)), "DROPPED");
    assert.equal(h.alerts.length, 1);
  });

  it("shares one in-flight poll between concurrent callers", async () => {
    const h = createHarness({ latencyMs: 20, script: { [hash(13)]: [{ status: "SUCCESS", ledger: 1 }] } });
    await h.coordinator.track({ txHash: hash(13), kind: "DEPOSIT" });
    const [s1, s2] = await Promise.all([h.coordinator.pollDue(), h.coordinator.pollDue()]);
    assert.strictEqual(s1, s2);
    assert.equal(h.rpcCalls.length, 1);
  });

  it("start() polls in the background and stop() halts it", async () => {
    const h = createHarness({ script: { [hash(14)]: [{ status: "SUCCESS", ledger: 1 }] } });
    await h.coordinator.track({ txHash: hash(14), kind: "DEPOSIT" });
    h.coordinator.start(10);
    for (let i = 0; i < 50 && [...h.db.rows.values()][0].status === "PENDING"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.coordinator.stop();
    assert.equal([...h.db.rows.values()][0].status, "SUCCESS");
  });
});

describe("Notification WebSocket delivers transaction finality to the owner", () => {
  const ORIGIN = "http://localhost:3000";
  let server: http.Server;
  let url: string;
  const hub = new UserNotificationHub();
  let notifications: ReturnType<typeof attachNotificationSocketServer>;
  let chat: ReturnType<typeof attachChatSocketServer>;

  before(async () => {
    server = http.createServer();
    // Same wiring as server.ts: chat lets the notification path through
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

  function open(path: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${url}${path}`, { headers: { Origin: ORIGIN } });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  function nextFrame(socket: WebSocket): Promise<any> {
    return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
  }

  it("pushes the coordinator's status change to the authenticated user's socket", async () => {
    const socket = await open("/api/v1/notifications/ws");
    const ready = nextFrame(socket);
    socket.send(JSON.stringify({ type: "auth", token: signAccessToken({ userId: "ws-user", email: "w@x.io", username: "w" }) }));
    assert.deepEqual(await ready, { type: "ready", userId: "ws-user" });

    const h = createHarness({ hub, script: { [hash(20)]: [{ status: "SUCCESS", ledger: 77 }] } });
    await h.coordinator.track({ txHash: hash(20), kind: "DEPOSIT", userId: "ws-user" });
    const frame = nextFrame(socket);
    await h.coordinator.pollDue();

    const received = await frame;
    assert.equal(received.type, "notification");
    assert.equal(received.notification.type, TRANSACTION_STATUS_EVENT);
    assert.equal(received.notification.data.txHash, hash(20));
    assert.equal(received.notification.data.status, "SUCCESS");
    assert.equal(received.notification.data.ledgerSeq, 77);
    socket.close();
  });

  it("closes sockets that send an invalid token", async () => {
    const socket = await open("/api/notifications/ws");
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(JSON.stringify({ type: "auth", token: "garbage" }));
    assert.equal(await closed, 4401);
  });

  it("still rejects unknown upgrade paths", async () => {
    await assert.rejects(open("/api/v1/unknown/ws"), /HTTP 404/);
  });
});

describe("FinancialService hands submitted hashes to the coordinator", () => {
  const wallet = Keypair.random().publicKey();
  const txHash = hash(30);

  function createFinancialDb() {
    const member = {
      id: "member-1",
      leagueId: "11111111-1111-1111-1111-111111111111",
      userId: "user-30",
      paymentStatus: PaymentStatus.PAYMENT_INITIATED,
      league: { id: "11111111-1111-1111-1111-111111111111", entryFee: 10 },
    };
    return {
      leagueMember: {
        findUnique: async () => member,
        update: async ({ data }: any) => ({ ...member, ...data }),
      },
      transaction: {
        findFirst: async () => null,
        create: async ({ data }: any) => ({ id: "tx-30", ...data }),
      },
    };
  }

  const stellar: any = {
    isValidTransactionHash: (h: string) => /^[a-f0-9]{64}$/i.test(h),
    isValidStellarAddress: () => true,
  };
  const audit = { record: () => undefined };

  it("tracks the deposit hash with its ledger row", async () => {
    const service = new FinancialService(createFinancialDb(), stellar, undefined, audit);
    const tracked: any[] = [];
    service.setTransactionTracker({ track: async (input) => tracked.push(input) });

    await service.submitPayment("user-30", "11111111-1111-1111-1111-111111111111", {
      stellarTxHash: txHash,
      stellarAddress: wallet,
    });
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0].kind, "DEPOSIT");
    assert.equal(tracked[0].txHash, txHash);
    assert.equal(tracked[0].userId, "user-30");
    assert.equal(tracked[0].transactionId, "tx-30");
  });

  it("never fails the payment when tracking fails", async () => {
    const service = new FinancialService(createFinancialDb(), stellar, undefined, audit);
    service.setTransactionTracker({
      track: async () => {
        throw new Error("database unavailable");
      },
    });
    const result = await service.submitPayment("user-30", "11111111-1111-1111-1111-111111111111", {
      stellarTxHash: txHash,
      stellarAddress: wallet,
    });
    assert.equal(result.transaction.type, TransactionType.ENTRY_FEE);
  });
});
