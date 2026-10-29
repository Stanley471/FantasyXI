import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Contract, Keypair, StrKey, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  decodeSorobanContractEvent,
  MemorySorobanEventStore,
  SOROBAN_EVENT_SCHEMAS,
  SOROBAN_INGESTION_CHECKPOINT_ID,
  SorobanEventIngestionService,
  SorobanEventSource,
  SorobanRpcRateLimitError,
  toJsonSafe,
} from "../services/financial/sorobanEventIngestionService.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const PLAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const TREASURY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();

const sym = (name: string) => xdr.ScVal.scvSymbol(name);
const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "u64" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const addr = (a: string) => nativeToScVal(a, { type: "address" });
const tuple = (...vals: xdr.ScVal[]) => xdr.ScVal.scvVec(vals);

let seq = 0;
function rpcEvent(
  topic: xdr.ScVal[],
  value: xdr.ScVal,
  ledger = 1000,
  overrides: Partial<rpc.Api.EventResponse> = {}
): rpc.Api.EventResponse {
  seq += 1;
  return {
    id: `${String(ledger).padStart(19, "0")}-${String(seq).padStart(10, "0")}`,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-10-28T12:00:00Z",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: "ab".repeat(32),
    contractId: new Contract(CONTRACT_ID),
    topic,
    value,
    ...overrides,
  } as rpc.Api.EventResponse;
}

describe("Soroban event decoding (#230)", () => {
  it("decodes LeagueDeposit events", () => {
    const decoded = decodeSorobanContractEvent(
      rpcEvent([sym("deposit"), u64(42)], tuple(addr(PLAYER), i128(100_000_000n)), 1234)
    );
    assert.equal(decoded.category, "LeagueDeposit");
    assert.equal(decoded.eventName, "deposit");
    assert.equal(decoded.contractId, CONTRACT_ID);
    assert.equal(decoded.leagueId, "42");
    assert.equal(decoded.ledgerSeq, 1234);
    assert.deepEqual(decoded.ledgerClosedAt, new Date("2026-10-28T12:00:00Z"));
    assert.deepEqual(decoded.payload, { leagueId: "42", participant: PLAYER, amount: "100000000" });
    assert.doesNotThrow(() => JSON.stringify(decoded));
  });

  it("decodes Settlement events, including merkle roots as hex", () => {
    const settle = decodeSorobanContractEvent(
      rpcEvent([sym("settle"), u64(7)], tuple(i128(950n), i128(50n)))
    );
    assert.equal(settle.category, "Settlement");
    assert.deepEqual(settle.payload, { leagueId: "7", totalPayout: "950", platformFee: "50" });

    const root = Buffer.alloc(32, 0xab);
    const merkle = decodeSorobanContractEvent(
      rpcEvent([sym("m_settle"), u64(7)], tuple(xdr.ScVal.scvBytes(root), i128(1_000n)))
    );
    assert.equal(merkle.category, "Settlement");
    assert.deepEqual(merkle.payload, { leagueId: "7", merkleRoot: "ab".repeat(32), totalPrizePool: "1000" });

    const claim = decodeSorobanContractEvent(
      rpcEvent([sym("m_claimed"), u64(7)], tuple(addr(PLAYER), i128(25n)))
    );
    assert.deepEqual(claim.payload, { leagueId: "7", winner: PLAYER, amount: "25" });
  });

  it("decodes every Refund event variant", () => {
    for (const name of ["EmergencyRefund", "DepositRefunded", "LeagueRefundClaimed"]) {
      const decoded = decodeSorobanContractEvent(
        rpcEvent([sym(name), u64(3)], tuple(addr(PLAYER), i128(5_000_000n)))
      );
      assert.equal(decoded.category, "Refund", name);
      assert.deepEqual(decoded.payload, { leagueId: "3", participant: PLAYER, amount: "5000000" });
    }
  });

  it("decodes FeeWithdrawal (timelock) events keyed by proposal", () => {
    const decoded = decodeSorobanContractEvent(
      rpcEvent([sym("TimelockExecuted"), u64(9)], tuple(addr(TREASURY), i128(200_000_000n)))
    );
    assert.equal(decoded.category, "FeeWithdrawal");
    assert.equal(decoded.leagueId, null);
    assert.deepEqual(decoded.payload, { proposalId: "9", destination: TREASURY, amount: "200000000" });
  });

  it("decodes governance events with scalar data and extra topics", () => {
    const frozen = decodeSorobanContractEvent(
      rpcEvent([sym("LeagueFrozen"), u64(4)], xdr.ScVal.scvBytes(Buffer.from("beef", "hex")))
    );
    assert.deepEqual(frozen.payload, { leagueId: "4", reasonHash: "beef" });

    const proposed = decodeSorobanContractEvent(
      rpcEvent(
        [sym("PauseActionProposed"), u64(11), u32(2)],
        tuple(addr(TREASURY), xdr.ScVal.scvBytes(Buffer.from("01", "hex")))
      )
    );
    assert.equal(proposed.category, "Governance");
    assert.deepEqual(proposed.payload, { proposalId: "11", action: 2, caller: TREASURY, reasonHash: "01" });
  });

  it("decodes affiliate payouts", () => {
    const decoded = decodeSorobanContractEvent(
      rpcEvent([sym("affiliate"), u64(5)], tuple(addr(TREASURY), i128(10n)))
    );
    assert.equal(decoded.category, "Affiliate");
    assert.deepEqual(decoded.payload, { leagueId: "5", affiliate: TREASURY, amount: "10" });
  });

  it("keeps unknown events with their raw decoded topics and data", () => {
    const map = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("count"), val: u32(3) }),
      new xdr.ScMapEntry({ key: sym("big"), val: i128(2n ** 100n) }),
    ]);
    const decoded = decodeSorobanContractEvent(rpcEvent([sym("SomethingNew"), u64(1)], map));
    assert.equal(decoded.category, "Other");
    assert.deepEqual(decoded.payload, {
      topics: ["1"],
      data: { count: 3, big: (2n ** 100n).toString() },
    });
  });

  it("accepts base64-encoded XDR topics and values", () => {
    const decoded = decodeSorobanContractEvent(
      rpcEvent(
        [sym("deposit").toXDR("base64"), u64(8).toXDR("base64")] as unknown as xdr.ScVal[],
        tuple(addr(PLAYER), i128(1n)).toXDR("base64") as unknown as xdr.ScVal
      )
    );
    assert.deepEqual(decoded.payload, { leagueId: "8", participant: PLAYER, amount: "1" });
  });

  it("has a schema for every event the escrow contract publishes", () => {
    for (const name of [
      "deposit", "settle", "m_settle", "m_claimed", "EmergencyRefund", "DepositRefunded",
      "LeagueRefundClaimed", "TimelockProposed", "TimelockExecuted", "affiliate",
      "AffiliatePayoutTransferred", "LeagueFrozen", "PauseActionProposed",
      "PauseActionApproved", "PauseActionExecuted",
    ]) {
      assert.ok(SOROBAN_EVENT_SCHEMAS[name], `missing schema for ${name}`);
    }
  });

  it("converts nested native values into JSON-safe values", () => {
    assert.deepEqual(toJsonSafe({ a: [1n, new Uint8Array([1, 255])], b: new Map([["k", 2n]]) }), {
      a: ["1", "01ff"],
      b: { k: "2" },
    });
  });
});

/** Fake RPC that serves a fixed list of events page by page using numeric cursors. */
class FakeRpc implements SorobanEventSource {
  public requests: rpc.Api.GetEventsRequest[] = [];
  public failures: unknown[] = [];

  constructor(public events: rpc.Api.EventResponse[], public latestLedger = 2000, public oldestLedger = 1) {}

  async getLatestLedger() {
    return { sequence: this.latestLedger };
  }

  async getHealth() {
    return { oldestLedger: this.oldestLedger, latestLedger: this.latestLedger };
  }

  async getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    this.requests.push(request);
    const failure = this.failures.shift();
    if (failure) throw failure;
    const limit = request.limit ?? 100;
    let start: number;
    if (request.cursor) {
      start = Number(request.cursor);
    } else {
      if (request.startLedger! < this.oldestLedger) throw new Error("startLedger must be within the ledger range");
      start = this.events.findIndex((e) => e.ledger >= request.startLedger!);
      if (start < 0) start = this.events.length;
    }
    const page = this.events.slice(start, start + limit);
    return {
      events: page,
      cursor: String(start + page.length),
      latestLedger: this.latestLedger,
      oldestLedger: this.oldestLedger,
      latestLedgerCloseTime: "",
      oldestLedgerCloseTime: "",
    } as rpc.Api.GetEventsResponse;
  }
}

function sampleEvents(count: number, firstLedger = 1000): rpc.Api.EventResponse[] {
  return Array.from({ length: count }, (_, i) =>
    rpcEvent([sym("deposit"), u64(i)], tuple(addr(PLAYER), i128(BigInt(i))), firstLedger + Math.floor(i / 2))
  );
}

describe("SorobanEventIngestionService daemon (#230)", () => {
  it("indexes every event across pages without gaps or duplicates", async () => {
    const events = sampleEvents(25);
    const source = new FakeRpc(events);
    const store = new MemorySorobanEventStore();
    const service = new SorobanEventIngestionService({
      source, store, contractId: CONTRACT_ID, startLedger: 1000, batchSize: 10,
    });

    assert.equal(await service.pollOnce(), 10);
    assert.equal(await service.pollOnce(), 10);
    assert.equal(await service.pollOnce(), 5);
    assert.equal(await service.pollOnce(), 0);

    assert.deepEqual([...store.events.keys()], events.map((e) => e.id));
    assert.equal(source.requests[0].startLedger, 1000);
    assert.equal(source.requests[1].cursor, "10");
    assert.deepEqual(source.requests[0].filters, [{ type: "contract", contractIds: [CONTRACT_ID] }]);
  });

  it("starts at the latest ledger when there is no checkpoint or start ledger", async () => {
    const source = new FakeRpc([], 5555);
    const service = new SorobanEventIngestionService({
      source, store: new MemorySorobanEventStore(), contractId: CONTRACT_ID,
    });
    await service.pollOnce();
    assert.equal(source.requests[0].startLedger, 5555);
  });

  it("resumes from the saved checkpoint after a restart", async () => {
    const events = sampleEvents(12);
    const source = new FakeRpc(events);
    const store = new MemorySorobanEventStore();
    const first = new SorobanEventIngestionService({
      source, store, contractId: CONTRACT_ID, startLedger: 1000, batchSize: 5,
    });
    await first.pollOnce();
    first.stop();

    const restarted = new SorobanEventIngestionService({
      source, store, contractId: CONTRACT_ID, startLedger: 1000, batchSize: 5,
    });
    await restarted.pollOnce();
    await restarted.pollOnce();

    assert.equal(store.events.size, 12);
    assert.equal(source.requests[1].cursor, "5", "restart continues from the saved cursor");
  });

  it("does not advance the checkpoint when a poll fails", async () => {
    const source = new FakeRpc(sampleEvents(3));
    const store = new MemorySorobanEventStore();
    const service = new SorobanEventIngestionService({
      source, store, contractId: CONTRACT_ID, startLedger: 1000,
    });
    source.failures.push(new SorobanRpcRateLimitError(3_000));
    await assert.rejects(() => service.pollOnce(), SorobanRpcRateLimitError);
    assert.equal(store.checkpoints.size, 0);
    assert.equal(await service.pollOnce(), 3);
  });

  it("falls back to the ledger checkpoint when the cursor is missing and replays safely", async () => {
    const events = sampleEvents(6);
    const source = new FakeRpc(events);
    const store = new MemorySorobanEventStore();
    const service = new SorobanEventIngestionService({
      source, store, contractId: CONTRACT_ID, startLedger: 1000, batchSize: 3,
    });
    await service.pollOnce();
    // Lose the cursor; the full page means the checkpoint points one ledger back.
    const checkpoint = store.checkpoints.get(SOROBAN_INGESTION_CHECKPOINT_ID)!;
    assert.equal(checkpoint.lastLedger, events[2].ledger - 1);
    store.checkpoints.set(SOROBAN_INGESTION_CHECKPOINT_ID, { ...checkpoint, cursor: null });

    await service.pollOnce();
    await service.pollOnce();
    assert.deepEqual([...store.events.keys()].sort(), events.map((e) => e.id).sort());
  });

  it("restarts at the oldest retained ledger when the checkpoint has aged out", async () => {
    const events = sampleEvents(4, 3000);
    const source = new FakeRpc(events, 4000, 3000);
    const store = new MemorySorobanEventStore();
    store.checkpoints.set(SOROBAN_INGESTION_CHECKPOINT_ID, { lastLedger: 100, cursor: null });
    const logs: string[] = [];
    const service = new SorobanEventIngestionService({
      source, store, contractId: CONTRACT_ID,
      logger: { info: () => {}, warn: () => {}, error: (m: string) => logs.push(m) },
    });
    assert.equal(await service.pollOnce(), 4);
    assert.equal(source.requests.at(-1)!.startLedger, 3000);
    assert.match(logs[0], /outside RPC retention/);
  });

  it("backs off exponentially and honours Retry-After on rate limits", () => {
    const service = new SorobanEventIngestionService({
      source: new FakeRpc([]), store: new MemorySorobanEventStore(), contractId: CONTRACT_ID,
      baseBackoffMs: 1_000, maxBackoffMs: 60_000,
    });
    assert.equal(service.nextDelayAfterError(new Error("boom"), 1), 1_000);
    assert.equal(service.nextDelayAfterError(new Error("boom"), 3), 4_000);
    assert.equal(service.nextDelayAfterError(new Error("boom"), 20), 60_000);
    assert.equal(service.nextDelayAfterError(new SorobanRpcRateLimitError(30_000), 1), 30_000);
    const httpError = Object.assign(new Error("Request failed"), {
      response: { status: 429, headers: { "retry-after": "12" } },
    });
    assert.equal(service.nextDelayAfterError(httpError, 1), 12_000);
  });

  it("stores events that fail to decode instead of skipping them", async () => {
    const bad = rpcEvent([sym("deposit"), u64(1)], tuple(addr(PLAYER), i128(1n)));
    (bad as any).topic = ["not-base64-xdr!!"];
    const store = new MemorySorobanEventStore();
    const service = new SorobanEventIngestionService({
      source: new FakeRpc([bad]), store, contractId: CONTRACT_ID, startLedger: 1000,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await service.pollOnce();
    assert.equal(store.events.get(bad.id)?.eventName, "undecodable");
  });
});
