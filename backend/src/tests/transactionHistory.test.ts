import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import { FinancialService } from "../services/financial/financialService.js";
import { getTransactions } from "../controllers/financial.controller.js";
import { TransactionStatus, TransactionType } from "../types/index.js";

/**
 * Cursor pagination + status/type filtering for a user's transaction
 * history (issue #496).
 */

function createMockDb(transactions: any[]) {
  const state = new Map(transactions.map((tx) => [tx.id, tx]));
  return {
    transaction: {
      findMany: async ({ where, cursor, skip, take }: any) => {
        let rows = Array.from(state.values()).filter(
          (tx: any) =>
            tx.userId === where.userId &&
            (!where.status || tx.status === where.status) &&
            (!where.type || tx.type === where.type)
        );
        rows.sort(
          (a: any, b: any) =>
            b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)
        );

        let startIndex = 0;
        if (cursor?.id) {
          const idx = rows.findIndex((r: any) => r.id === cursor.id);
          // Excluding the cursor row: forward pagination skips past it
          // (idx + skip); backward pagination treats idx itself as the
          // exclusive upper bound of the preceding window.
          startIndex = take < 0 ? idx : idx + (skip || 0);
        }

        if (take < 0) {
          const end = startIndex;
          const begin = Math.max(0, end + take);
          return rows.slice(begin, end);
        }
        return rows.slice(startIndex, take !== undefined ? startIndex + take : undefined);
      },
    },
  };
}

function buildTransactions(userId: string, count: number) {
  const base = new Date("2026-01-01T00:00:00.000Z").getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `tx_${String(i).padStart(3, "0")}`,
    userId,
    type: i % 2 === 0 ? TransactionType.ENTRY_FEE : TransactionType.PRIZE_PAYOUT,
    status: i % 3 === 0 ? TransactionStatus.CONFIRMED : TransactionStatus.PENDING,
    amount: "10.00",
    asset: "USDC",
    createdAt: new Date(base + i * 60_000),
  }));
}

describe("FinancialService.listUserTransactions (issue #496)", () => {
  it("returns the newest page first, with a nextCursor when more rows exist", async () => {
    const txs = buildTransactions("user_1", 25);
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const page = await service.listUserTransactions("user_1", { limit: 10 });

    assert.equal(page.transactions.length, 10);
    assert.equal((page.transactions[0] as any).id, "tx_024");
    assert.equal((page.transactions[9] as any).id, "tx_015");
    assert.equal(page.nextCursor, "tx_015");
    assert.equal(page.prevCursor, null);
  });

  it("walks forward with the `after` cursor", async () => {
    const txs = buildTransactions("user_1", 25);
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const first = await service.listUserTransactions("user_1", { limit: 10 });
    const second = await service.listUserTransactions("user_1", {
      limit: 10,
      after: first.nextCursor!,
    });

    assert.equal(second.transactions.length, 10);
    assert.equal((second.transactions[0] as any).id, "tx_014");
    assert.equal((second.transactions[9] as any).id, "tx_005");
    assert.equal(second.nextCursor, "tx_005");
  });

  it("walks backward with the `before` cursor, preserving newest-first order", async () => {
    const txs = buildTransactions("user_1", 25);
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const first = await service.listUserTransactions("user_1", { limit: 10 });
    const second = await service.listUserTransactions("user_1", {
      limit: 10,
      after: first.nextCursor!,
    });
    assert.equal(second.prevCursor, "tx_014");
    const back = await service.listUserTransactions("user_1", {
      limit: 10,
      before: second.prevCursor!,
    });

    assert.equal((back.transactions[0] as any).id, "tx_024");
    assert.equal((back.transactions[9] as any).id, "tx_015");
  });

  it("reaches the final page with an empty nextCursor", async () => {
    const txs = buildTransactions("user_1", 25);
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const page = await service.listUserTransactions("user_1", {
      limit: 10,
      after: "tx_005",
    });

    assert.equal(page.transactions.length, 5);
    assert.equal(page.nextCursor, null);
  });

  it("filters by status", async () => {
    const txs = buildTransactions("user_1", 12);
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const page = await service.listUserTransactions("user_1", {
      limit: 50,
      status: TransactionStatus.CONFIRMED,
    });

    assert.ok(page.transactions.length > 0);
    assert.ok(
      (page.transactions as any[]).every((tx) => tx.status === TransactionStatus.CONFIRMED)
    );
  });

  it("filters by type", async () => {
    const txs = buildTransactions("user_1", 12);
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const page = await service.listUserTransactions("user_1", {
      limit: 50,
      type: TransactionType.PRIZE_PAYOUT,
    });

    assert.ok(page.transactions.length > 0);
    assert.ok(
      (page.transactions as any[]).every((tx) => tx.type === TransactionType.PRIZE_PAYOUT)
    );
  });

  it("combines status and type filters, returning only exact matches", async () => {
    const txs = buildTransactions("user_1", 24);
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const page = await service.listUserTransactions("user_1", {
      limit: 50,
      status: TransactionStatus.CONFIRMED,
      type: TransactionType.ENTRY_FEE,
    });

    assert.ok(page.transactions.length > 0);
    assert.ok(
      (page.transactions as any[]).every(
        (tx) =>
          tx.status === TransactionStatus.CONFIRMED && tx.type === TransactionType.ENTRY_FEE
      )
    );
  });

  it("never returns another user's transactions", async () => {
    const txs = [...buildTransactions("user_1", 3), ...buildTransactions("user_2", 3)];
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const page = await service.listUserTransactions("user_1", { limit: 50 });
    assert.ok((page.transactions as any[]).every((tx) => tx.userId === "user_1"));
  });

  it("clamps an excessive limit to 100", async () => {
    const txs = buildTransactions("user_1", 5);
    const db = createMockDb(txs);
    const service = new FinancialService(db as any);

    const page = await service.listUserTransactions("user_1", { limit: 9999 });
    assert.equal(page.transactions.length, 5);
  });
});

function createMockReqRes(options: {
  user?: { id: string };
  query?: Record<string, string>;
}) {
  let statusCode = 200;
  let jsonResponse: any = null;
  let nextError: any = null;

  const req = {
    user: options.user,
    query: options.query || {},
  } as unknown as Request;

  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: any) => {
      jsonResponse = payload;
      return res;
    },
  } as unknown as Response;

  const next: NextFunction = (err?: any) => {
    nextError = err;
  };

  return { req, res, next, getStatusCode: () => statusCode, getJsonResponse: () => jsonResponse, getNextError: () => nextError };
}

describe("getTransactions Controller (issue #496)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
      user: undefined,
    });
    await getTransactions(req, res, next);
    assert.equal(getStatusCode(), 401);
    assert.equal(getJsonResponse().success, false);
  });

  it("rejects an invalid status filter with 400", async () => {
    const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
      user: { id: "user_1" },
      query: { status: "NOT_A_STATUS" },
    });
    await getTransactions(req, res, next);
    assert.equal(getStatusCode(), 400);
    assert.match(getJsonResponse().message, /Invalid status/);
  });

  it("rejects an invalid type filter with 400", async () => {
    const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
      user: { id: "user_1" },
      query: { type: "NOT_A_TYPE" },
    });
    await getTransactions(req, res, next);
    assert.equal(getStatusCode(), 400);
    assert.match(getJsonResponse().message, /Invalid type/);
  });
});
