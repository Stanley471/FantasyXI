import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPlayers } from "../controllers/player.controller.js";
import { prisma } from "../config/db.js";

describe("Player List API Server-Side Pagination", () => {
  it("should apply default pagination when page and limit query params are omitted", async () => {
    let capturedArgs: any = null;
    const originalFindMany = prisma.player.findMany;
    const originalCount = prisma.player.count;

    (prisma as any).player.findMany = async (args: any) => {
      capturedArgs = args;
      return [
        { id: 1, displayName: "Bukayo Saka", totalPoints: 100 },
        { id: 2, displayName: "Cole Palmer", totalPoints: 95 },
      ];
    };
    (prisma as any).player.count = async () => 150;

    try {
      const req: any = { query: {} };
      let responseData: any = null;
      const res: any = {
        json: (data: any) => {
          responseData = data;
        },
      };
      const next = (err: any) => {
        if (err) throw err;
      };

      await getPlayers(req, res, next);

      assert.strictEqual(capturedArgs.skip, 0);
      assert.strictEqual(capturedArgs.take, 50);
      assert.strictEqual(responseData.success, true);
      assert.strictEqual(responseData.data.length, 2);
      assert.strictEqual(responseData.pagination.page, 1);
      assert.strictEqual(responseData.pagination.limit, 50);
      assert.strictEqual(responseData.pagination.total, 150);
      assert.strictEqual(responseData.pagination.totalCount, 150);
      assert.strictEqual(responseData.pagination.totalPages, 3);
      assert.strictEqual(responseData.pagination.nextPage, 2);
      assert.strictEqual(responseData.pagination.prevPage, null);
      assert.strictEqual(responseData.pagination.hasNextPage, true);
      assert.strictEqual(responseData.pagination.hasPrevPage, false);
    } finally {
      (prisma as any).player.findMany = originalFindMany;
      (prisma as any).player.count = originalCount;
    }
  });

  it("should compute correct skip and take for page 2 with limit 10", async () => {
    let capturedArgs: any = null;
    const originalFindMany = prisma.player.findMany;
    const originalCount = prisma.player.count;

    (prisma as any).player.findMany = async (args: any) => {
      capturedArgs = args;
      return [{ id: 11, displayName: "Erling Haaland", totalPoints: 120 }];
    };
    (prisma as any).player.count = async () => 35;

    try {
      const req: any = { query: { page: "2", limit: "10" } };
      let responseData: any = null;
      const res: any = {
        json: (data: any) => {
          responseData = data;
        },
      };
      const next = (err: any) => {
        if (err) throw err;
      };

      await getPlayers(req, res, next);

      assert.strictEqual(capturedArgs.skip, 10);
      assert.strictEqual(capturedArgs.take, 10);
      assert.strictEqual(responseData.pagination.page, 2);
      assert.strictEqual(responseData.pagination.limit, 10);
      assert.strictEqual(responseData.pagination.total, 35);
      assert.strictEqual(responseData.pagination.totalCount, 35);
      assert.strictEqual(responseData.pagination.totalPages, 4);
      assert.strictEqual(responseData.pagination.nextPage, 3);
      assert.strictEqual(responseData.pagination.prevPage, 1);
      assert.strictEqual(responseData.pagination.hasNextPage, true);
      assert.strictEqual(responseData.pagination.hasPrevPage, true);
    } finally {
      (prisma as any).player.findMany = originalFindMany;
      (prisma as any).player.count = originalCount;
    }
  });

  it("should set nextPage to null when on the final page", async () => {
    const originalFindMany = prisma.player.findMany;
    const originalCount = prisma.player.count;

    (prisma as any).player.findMany = async () => [
      { id: 21, displayName: "Ollie Watkins", totalPoints: 80 },
    ];
    (prisma as any).player.count = async () => 21;

    try {
      const req: any = { query: { page: "3", limit: "10" } };
      let responseData: any = null;
      const res: any = {
        json: (data: any) => {
          responseData = data;
        },
      };
      const next = (err: any) => {
        if (err) throw err;
      };

      await getPlayers(req, res, next);

      assert.strictEqual(responseData.pagination.page, 3);
      assert.strictEqual(responseData.pagination.totalPages, 3);
      assert.strictEqual(responseData.pagination.nextPage, null);
      assert.strictEqual(responseData.pagination.prevPage, 2);
      assert.strictEqual(responseData.pagination.hasNextPage, false);
      assert.strictEqual(responseData.pagination.hasPrevPage, true);
    } finally {
      (prisma as any).player.findMany = originalFindMany;
      (prisma as any).player.count = originalCount;
    }
  });

  it("should sanitize invalid or out-of-bound page and limit inputs", async () => {
    let capturedArgs: any = null;
    const originalFindMany = prisma.player.findMany;
    const originalCount = prisma.player.count;

    (prisma as any).player.findMany = async (args: any) => {
      capturedArgs = args;
      return [];
    };
    (prisma as any).player.count = async () => 0;

    try {
      const req: any = { query: { page: "-5", limit: "500" } };
      let responseData: any = null;
      const res: any = {
        json: (data: any) => {
          responseData = data;
        },
      };
      const next = (err: any) => {
        if (err) throw err;
      };

      await getPlayers(req, res, next);

      assert.strictEqual(capturedArgs.skip, 0);
      assert.strictEqual(capturedArgs.take, 100);
      assert.strictEqual(responseData.pagination.page, 1);
      assert.strictEqual(responseData.pagination.limit, 100);
      assert.strictEqual(responseData.pagination.total, 0);
      assert.strictEqual(responseData.pagination.totalCount, 0);
      assert.strictEqual(responseData.pagination.totalPages, 0);
      assert.strictEqual(responseData.pagination.nextPage, null);
      assert.strictEqual(responseData.pagination.hasNextPage, false);
    } finally {
      (prisma as any).player.findMany = originalFindMany;
      (prisma as any).player.count = originalCount;
    }
  });
});
