import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  SorobanEventIngestionService,
  decodeScValToJson,
  type RawSorobanRpcEvent,
} from "../services/financial/sorobanEventIngestionService.js";

function createMockDb(initialState: {
  cursor?: { id: string; lastLedger: number; cursor: string | null } | null;
  sorobanEvents?: any[];
  contractEvents?: any[];
} = {}) {
  const state = {
    cursor: initialState.cursor ?? null,
    sorobanEvents: [...(initialState.sorobanEvents ?? [])],
    contractEvents: [...(initialState.contractEvents ?? [])],
  };

  return {
    state,
    indexerCursor: {
      findUnique: async ({ where }: any) =>
        state.cursor && state.cursor.id === where.id ? { ...state.cursor } : null,
      upsert: async ({ create, update }: any) => {
        if (!state.cursor) {
          state.cursor = { ...create };
        } else {
          state.cursor = { ...state.cursor, ...update };
        }
        return state.cursor;
      },
    },
    sorobanContractEvent: {
      findFirst: async ({ where, orderBy }: any) => {
        if (orderBy?.ledgerSeq === "desc") {
          const sorted = [...state.sorobanEvents].sort((a, b) => b.ledgerSeq - a.ledgerSeq);
          return sorted[0] ?? null;
        }
        return (
          state.sorobanEvents.find(
            (e) =>
              e.pagingToken === where.pagingToken &&
              e.txHash === where.txHash &&
              e.eventType === where.eventType &&
              e.ledgerSeq === where.ledgerSeq
          ) ?? null
        );
      },
      create: async ({ data }: any) => {
        const record = { id: `sce_${state.sorobanEvents.length + 1}`, ...data };
        state.sorobanEvents.push(record);
        return record;
      },
    },
    contractEvent: {
      findFirst: async ({ where, orderBy }: any) => {
        if (orderBy?.ledgerSeq === "desc") {
          const sorted = [...state.contractEvents].sort((a, b) => b.ledgerSeq - a.ledgerSeq);
          return sorted[0] ?? null;
        }
        return (
          state.contractEvents.find(
            (e) =>
              e.txHash === where.txHash &&
              e.eventType === where.eventType &&
              e.ledgerSeq === where.ledgerSeq
          ) ?? null
        );
      },
      create: async ({ data }: any) => {
        const record = { id: `ce_${state.contractEvents.length + 1}`, ...data };
        state.contractEvents.push(record);
        return record;
      },
    },
  };
}

describe("SorobanEventIngestionService (Issue #230)", () => {
  it("decodes complex XDR ScVal maps, vectors, symbols, i128/u128, and addresses into JSON-safe payloads", () => {
    const depositorAddress = Keypair.random().publicKey();
    const mapScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("user"),
        val: nativeToScVal(depositorAddress, { type: "address" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("amount"),
        val: nativeToScVal(250_000_000n, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("tags"),
        val: xdr.ScVal.scvVec([
          xdr.ScVal.scvString("usdc"),
          xdr.ScVal.scvU32(101),
        ]),
      }),
    ]);

    const decoded = decodeScValToJson(mapScVal.toXDR("base64")) as Record<string, any>;
    assert.equal(decoded.user, depositorAddress);
    assert.equal(decoded.amount, "250000000");
    assert.deepEqual(decoded.tags, ["usdc", 101]);
  });

  it("polls getEvents from saved cursor and persists LeagueDeposit, Settlement, Refund, and FeeWithdrawal events", async () => {
    const wallet1 = Keypair.random().publicKey();
    const wallet2 = Keypair.random().publicKey();
    const treasury = Keypair.random().publicKey();

    const sampleEvents: RawSorobanRpcEvent[] = [
      {
        id: "0001050-0001",
        pagingToken: "0001050-0001",
        ledger: 1050,
        ledgerClosedAt: "2026-03-01T12:00:00.000Z",
        contractId: "CCONTRACT123",
        txHash: "a".repeat(64),
        topic: [
          xdr.ScVal.scvSymbol("LeagueDeposit").toXDR("base64"),
          xdr.ScVal.scvU64(xdr.Uint64.fromString("42")).toXDR("base64"),
        ],
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("depositor"),
            val: nativeToScVal(wallet1, { type: "address" }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("amount"),
            val: nativeToScVal(50_000_000n, { type: "i128" }),
          }),
        ]).toXDR("base64"),
      },
      {
        id: "0001052-0001",
        pagingToken: "0001052-0001",
        ledger: 1052,
        ledgerClosedAt: "2026-03-01T12:01:00.000Z",
        contractId: "CCONTRACT123",
        txHash: "b".repeat(64),
        topic: [
          xdr.ScVal.scvSymbol("Settlement"),
          xdr.ScVal.scvString("league-uuid-99"),
        ],
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("winner"),
            val: nativeToScVal(wallet2, { type: "address" }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("payout"),
            val: nativeToScVal(95_000_000n, { type: "i128" }),
          }),
        ]),
      },
      {
        id: "0001055-0001",
        pagingToken: "0001055-0001",
        ledger: 1055,
        ledgerClosedAt: "2026-03-01T12:02:00.000Z",
        contractId: "CCONTRACT123",
        txHash: "c".repeat(64),
        topic: [xdr.ScVal.scvSymbol("Refund"), xdr.ScVal.scvU32(77)],
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("refundedCount"),
            val: xdr.ScVal.scvU32(4),
          }),
        ]),
      },
      {
        id: "0001058-0001",
        pagingToken: "0001058-0001",
        ledger: 1058,
        ledgerClosedAt: "2026-03-01T12:03:00.000Z",
        contractId: "CCONTRACT123",
        txHash: "d".repeat(64),
        topic: [xdr.ScVal.scvSymbol("FeeWithdrawal")],
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("recipient"),
            val: nativeToScVal(treasury, { type: "address" }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("feeAmount"),
            val: nativeToScVal(5_000_000n, { type: "i128" }),
          }),
        ]),
      },
    ];

    const db = createMockDb({
      cursor: { id: "soroban_event_ingestion_daemon", lastLedger: 1049, cursor: null },
    });

    let capturedRequest: any = null;
    const mockRpc = {
      getLatestLedger: async () => ({ id: "h", protocolVersion: 21, sequence: 1060 }),
      getEvents: async (req: any) => {
        capturedRequest = req;
        return { events: sampleEvents, latestLedger: 1060 } as any;
      },
    };

    const service = new SorobanEventIngestionService(db, mockRpc, {
      contractId: "CCONTRACT123",
    });

    const result = await service.pollOnce();
    assert.equal(capturedRequest.startLedger, 1050);
    assert.equal(result.polled, 4);
    assert.equal(result.ingested, 4);
    assert.equal(result.lastLedgerSeq, 1058);
    assert.equal(result.cursor, "0001058-0001");

    assert.equal(db.state.sorobanEvents.length, 4);
    assert.equal(db.state.sorobanEvents[0].eventType, "LeagueDeposit");
    assert.equal(db.state.sorobanEvents[0].leagueId, "42");
    assert.equal(db.state.sorobanEvents[0].ledgerSeq, 1050);
    assert.equal(db.state.sorobanEvents[0].txHash, "a".repeat(64));
    assert.equal(db.state.sorobanEvents[0].payload.depositor, wallet1);
    assert.equal(db.state.sorobanEvents[0].payload.amount, "50000000");

    assert.equal(db.state.sorobanEvents[1].eventType, "Settlement");
    assert.equal(db.state.sorobanEvents[2].eventType, "Refund");
    assert.equal(db.state.sorobanEvents[3].eventType, "FeeWithdrawal");
  });

  it("handles RPC 429 rate limits with exponential backoff and resumes seamlessly from saved checkpoint", async () => {
    const backoffDelays: number[] = [];
    let rpcCalls = 0;

    const db = createMockDb({
      cursor: {
        id: "soroban_event_ingestion_daemon",
        lastLedger: 2000,
        cursor: "0002000-0009",
      },
    });

    const mockRpc = {
      getLatestLedger: async () => ({ id: "h", protocolVersion: 21, sequence: 2010 }),
      getEvents: async (req: any) => {
        rpcCalls += 1;
        if (rpcCalls <= 2) {
          const err: any = new Error("429 Too Many Requests: Rate limit exceeded");
          err.status = 429;
          throw err;
        }
        return {
          events: [
            {
              id: "0002005-0001",
              pagingToken: "0002005-0001",
              ledger: 2005,
              ledgerClosedAt: "2026-03-01T15:00:00.000Z",
              txHash: "e".repeat(64),
              topic: [xdr.ScVal.scvSymbol("LeagueDeposit"), xdr.ScVal.scvU32(9)],
              value: xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("amount"),
                  val: xdr.ScVal.scvU32(100),
                }),
              ]),
            },
          ],
          latestLedger: 2005,
          requestUsed: req,
        } as any;
      },
    };

    const service = new SorobanEventIngestionService(db, mockRpc, {
      baseBackoffMs: 100,
      maxRetries: 4,
      sleepFn: async (ms) => {
        backoffDelays.push(ms);
      },
    });

    const firstPoll = await service.pollOnce();
    assert.equal(rpcCalls, 3);
    assert.deepEqual(backoffDelays, [100, 200]);
    assert.equal(firstPoll.ingested, 1);
    assert.equal(firstPoll.lastLedgerSeq, 2005);
    assert.equal(db.state.cursor?.lastLedger, 2005);
    assert.equal(db.state.cursor?.cursor, "0002005-0001");

    // Simulate daemon restart with new service instance sharing the same DB
    let restartCursorSeen: string | undefined;
    const restartedRpc = {
      getLatestLedger: async () => ({ id: "h", protocolVersion: 21, sequence: 2010 }),
      getEvents: async (req: any) => {
        restartCursorSeen = req.cursor;
        return { events: [], latestLedger: 2010 } as any;
      },
    };
    const restartedDaemon = new SorobanEventIngestionService(db, restartedRpc);
    const secondPoll = await restartedDaemon.pollOnce();
    assert.equal(restartCursorSeen, "0002005-0001");
    assert.equal(secondPoll.lastLedgerSeq, 2010);
  });
});
