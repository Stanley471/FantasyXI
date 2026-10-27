import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RefreshTokenService, RefreshTokenUnauthorizedError } from "../services/auth/refreshTokenService.js";
import crypto from "crypto";

function store() {
  const rows: any[] = [];
  const db: any = {
    refreshToken: {
      create: async ({ data }: any) => { const row = { id: crypto.randomUUID(), revokedAt: null, ...data }; rows.push(row); return row; },
      findUnique: async ({ where, include }: any) => {
        const row = rows.find((candidate) => candidate.tokenHash === where.tokenHash);
        return row ? { ...row, ...(include?.user ? { user: { id: row.userId, email: "test@example.com", username: "tester", role: "USER" } } : {}) } : null;
      },
      updateMany: async ({ where, data }: any) => {
        const found = rows.filter((row) => (!where.id || row.id === where.id) && (!where.familyId || row.familyId === where.familyId) && (!where.revokedAt || row.revokedAt === where.revokedAt) && (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt));
        for (const row of found) row.revokedAt = data.revokedAt;
        return { count: found.length };
      },
    },
    $transaction: async (fn: any) => fn(db),
  };
  return { db, rows };
}

describe("refresh token rotation", () => {
  it("invalidates the exchanged token and issues the next token in the same family", async () => {
    const { db, rows } = store();
    const service = new RefreshTokenService(db);
    const first = await service.issue({ id: "user-1", email: "test@example.com", username: "tester" });
    const second = await service.rotate(first.refreshToken);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].revokedAt);
    assert.equal(rows[0].familyId, rows[1].familyId);
    assert.ok(second.token);
    await assert.rejects(() => service.rotate(first.refreshToken), RefreshTokenUnauthorizedError);
    assert.ok(rows.every((row) => row.revokedAt), "reuse revokes the complete token family");
  });

  it("rejects expired refresh tokens with 401-domain error", async () => {
    const { db, rows } = store();
    const service = new RefreshTokenService(db);
    const issued = await service.issue({ id: "user-1", email: "test@example.com", username: "tester" });
    rows[0].expiresAt = new Date(Date.now() - 1000);
    await assert.rejects(() => service.rotate(issued.refreshToken), RefreshTokenUnauthorizedError);
  });
});
