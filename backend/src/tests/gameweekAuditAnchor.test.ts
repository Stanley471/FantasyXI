import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  canonicalJson,
  normalizeSnapshot,
  computeAuditDigest,
  GameweekAuditAnchorService,
  type AnchorHorizon,
  type GameweekAuditSnapshot,
} from "../services/financial/gameweekAuditAnchorService.js";
import { createAuditAnchorRouter } from "../routes/auditAnchor.routes.js";

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const SIGNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5));

const snapshot = (): GameweekAuditSnapshot => ({
  version: 1,
  gameweekFplId: 12,
  leagues: [
    {
      leagueId: "league-b",
      members: [
        { userId: "u2", squadId: "s2", gameweekPoints: 40, totalPoints: 400, rank: 2 },
        { userId: "u1", squadId: "s1", gameweekPoints: 55, totalPoints: 410, rank: 1 },
      ],
      prizes: [{ userId: "u1", amount: "90.00" }],
    },
    {
      leagueId: "league-a",
      members: [{ userId: "u3", squadId: "s3", gameweekPoints: 10, totalPoints: 100, rank: 1 }],
      prizes: [],
    },
  ],
});

describe("Audit digest computation (#559)", () => {
  it("is a 32-byte hex digest that does not depend on input ordering or key order", () => {
    const a = snapshot();
    const b = snapshot();
    b.leagues.reverse();
    b.leagues[0].members.reverse();
    const digest = computeAuditDigest(a);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(computeAuditDigest(b), digest);
    // JSONB does not preserve key order; the digest must survive that.
    const reordered = JSON.parse(
      JSON.stringify(a, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))
    );
    assert.equal(computeAuditDigest(reordered), digest);
  });

  it("changes when any standing, point total, prize or gameweek changes", () => {
    const base = computeAuditDigest(snapshot());
    const points = snapshot();
    points.leagues[0].members[0].gameweekPoints += 1;
    const prize = snapshot();
    prize.leagues[0].prizes[0].amount = "91.00";
    const rank = snapshot();
    rank.leagues[1].members[0].rank = 2;
    const gameweek = snapshot();
    gameweek.gameweekFplId = 13;
    const extraLeague = snapshot();
    extraLeague.leagues.push({ leagueId: "league-c", members: [], prizes: [] });
    for (const changed of [points, prize, rank, gameweek, extraLeague]) {
      assert.notEqual(computeAuditDigest(changed), base);
    }
  });

  it("produces canonical JSON with sorted keys", () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] }), '{"a":[{"c":"x","d":null}],"b":1}');
  });
});

/** In-memory db with just the models the anchor service reads and writes. */
function createDb() {
  const anchors = new Map<number, any>();
  const gameweeks = [{ id: 1, fplId: 12, settledAt: new Date() }];
  const db: any = {
    anchors,
    gameweek: {
      findUnique: async ({ where }: any) =>
        gameweeks.find((g) => (where.id !== undefined ? g.id === where.id : g.fplId === where.fplId)) ?? null,
      findMany: async () => gameweeks.filter((g) => anchors.get(g.id)?.status !== "CONFIRMED"),
    },
    league: { findMany: async () => [{ id: "league-a" }, { id: "league-b" }] },
    leagueMember: {
      findMany: async () => [
        { leagueId: "league-a", userId: "u3", squadId: "s3", rank: 1, totalPoints: 100 },
        { leagueId: "league-b", userId: "u1", squadId: "s1", rank: 1, totalPoints: 410 },
        { leagueId: "league-b", userId: "u2", squadId: "s2", rank: 2, totalPoints: 400 },
      ],
    },
    leagueGameweekScore: { findMany: async () => [{ leagueId: "league-b", squadId: "s1", points: 55 }] },
    squadGameweekScore: {
      findMany: async () => [
        { squadId: "s1", points: 99 }, // overridden by the league's custom score
        { squadId: "s2", points: 40 },
        { squadId: "s3", points: 10 },
      ],
    },
    transaction: { findMany: async () => [{ leagueId: "league-b", userId: "u1", amount: 90 }] },
    gameweekAuditAnchor: {
      findUnique: async ({ where }: any) => anchors.get(where.gameweekId) ?? null,
      findMany: async () => [...anchors.values()].map((a) => ({ ...a, gameweek: { fplId: 12 } })),
      upsert: async ({ where, create, update }: any) => {
        const existing = anchors.get(where.gameweekId);
        const row = existing
          ? { ...existing, ...update, attempts: existing.attempts + 1 }
          : { attempts: 0, stellarTxHash: null, ledgerSeq: null, anchoredAt: null, ...create };
        anchors.set(where.gameweekId, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = { ...anchors.get(where.gameweekId), ...data };
        anchors.set(where.gameweekId, row);
        return row;
      },
    },
  };
  return db;
}

/** Fake Horizon that "confirms" submitted transactions and serves them back. */
function createHorizon() {
  const submitted: any[] = [];
  const chain = new Map<string, { memo_type: string; memo: string; ledger: number; successful: boolean }>();
  const state = { failSubmit: false };
  const horizon: AnchorHorizon = {
    async loadAccount(address) {
      return {
        accountId: () => address,
        sequenceNumber: () => "100",
        incrementSequenceNumber() {},
      };
    },
    async submitTransaction(tx) {
      if (state.failSubmit) throw new Error("horizon unavailable");
      submitted.push(tx);
      const hash = Buffer.from(tx.hash()).toString("hex");
      chain.set(hash, {
        memo_type: "hash",
        memo: Buffer.from(tx.memo.value).toString("base64"),
        ledger: 5000 + submitted.length,
        successful: true,
      });
      return { hash, ledger: 5000 + submitted.length };
    },
    async getTransaction(hash) {
      return chain.get(hash) ?? null;
    },
  };
  return { horizon, submitted, chain, state };
}

function createService(overrides: { signerSecret?: string | undefined } = {}) {
  const db = createDb();
  const h = createHorizon();
  const service = new GameweekAuditAnchorService({
    db,
    horizon: () => h.horizon,
    networkPassphrase: Networks.TESTNET,
    signerSecret: "signerSecret" in overrides ? overrides.signerSecret : SIGNER.secret(),
    logger: quiet,
  });
  return { service, db, h };
}

describe("GameweekAuditAnchorService (#559)", () => {
  it("builds the snapshot from standings, member points and prizes", async () => {
    const { service } = createService();
    const built = await service.buildSnapshot(1);
    assert.deepEqual(built, normalizeSnapshot(snapshot()));
    assert.equal(built.leagues[1].members.find((m) => m.userId === "u1")?.gameweekPoints, 55);
  });

  it("submits a zero-value transaction carrying the digest as MEMO_HASH and stores the receipt", async () => {
    const { service, db, h } = createService();
    const receipt = await service.anchorGameweek(1);

    assert.ok(receipt);
    assert.equal(receipt.status, "CONFIRMED");
    assert.equal(receipt.digest, computeAuditDigest(snapshot()));
    assert.equal(receipt.leagueCount, 2);
    assert.equal(receipt.memberCount, 3);

    assert.equal(h.submitted.length, 1);
    const tx = h.submitted[0];
    assert.equal(tx.memo.type, "hash");
    assert.equal(Buffer.from(tx.memo.value).toString("hex"), receipt.digest);
    assert.equal(tx.operations.length, 1);
    assert.equal(tx.operations[0].type, "bumpSequence"); // no funds move
    assert.equal(tx.source, SIGNER.publicKey());
    assert.equal(tx.signatures.length, 1);

    assert.equal(receipt.stellarTxHash, Buffer.from(tx.hash()).toString("hex"));
    assert.equal(receipt.ledgerSeq, 5001);
    assert.equal(db.anchors.get(1).stellarTxHash, receipt.stellarTxHash);
  });

  it("is idempotent for a confirmed gameweek", async () => {
    const { service, h } = createService();
    const first = await service.anchorGameweek(1);
    const second = await service.anchorGameweek(1);
    assert.equal(h.submitted.length, 1);
    assert.equal(second?.stellarTxHash, first?.stellarTxHash);
  });

  it("verifies the stored snapshot against the on-chain memo", async () => {
    const { service } = createService();
    await service.anchorGameweek(1);
    const result = await service.verify(12);
    assert.equal(result.verified, true);
    assert.equal(result.snapshotIntact, true);
    assert.equal(result.onChainMatches, true);
    assert.equal(result.onChainDigest, result.digest);
    assert.equal(result.reason, undefined);
  });

  it("detects a tampered snapshot", async () => {
    const { service, db } = createService();
    await service.anchorGameweek(1);
    db.anchors.get(1).snapshot.leagues[0].members[0].gameweekPoints = 9999;
    const result = await service.verify(12);
    assert.equal(result.verified, false);
    assert.equal(result.snapshotIntact, false);
    assert.match(result.reason!, /does not hash/);
  });

  it("detects a mismatched on-chain memo and a missing transaction", async () => {
    const { service, h } = createService();
    const receipt = await service.anchorGameweek(1);
    h.chain.get(receipt!.stellarTxHash!)!.memo = Buffer.alloc(32, 1).toString("base64");
    const mismatch = await service.verify(12);
    assert.equal(mismatch.verified, false);
    assert.equal(mismatch.onChainMatches, false);

    h.chain.delete(receipt!.stellarTxHash!);
    const missing = await service.verify(12);
    assert.equal(missing.verified, false);
    assert.match(missing.reason!, /not found/);
  });

  it("reports an unanchored gameweek", async () => {
    const { service } = createService();
    assert.deepEqual(await service.verify(12), {
      anchored: false,
      gameweekFplId: 12,
      verified: false,
      reason: "No confirmed audit anchor for this gameweek",
    });
  });

  it("marks the receipt FAILED on a submit error, never throws from the safe wrapper, and retries", async () => {
    const { service, db, h } = createService();
    h.state.failSubmit = true;
    assert.equal(await service.anchorGameweekSafely(1), null);
    assert.equal(db.anchors.get(1).status, "FAILED");
    assert.match(db.anchors.get(1).errorMessage, /horizon unavailable/);

    h.state.failSubmit = false;
    assert.equal(await service.retryUnanchored(), 1);
    assert.equal(db.anchors.get(1).status, "CONFIRMED");
  });

  it("does nothing without a signing key", async () => {
    const { service, h } = createService({ signerSecret: undefined });
    assert.equal(service.isConfigured(), false);
    assert.equal(await service.anchorGameweek(1), null);
    assert.equal(h.submitted.length, 0);
  });
});

describe("Public audit anchor API (#559)", () => {
  async function withServer(run: (base: string, ctx: ReturnType<typeof createService>) => Promise<void>) {
    const ctx = createService();
    await ctx.service.anchorGameweek(1);
    const app = express();
    app.use("/audit-anchors", createAuditAnchorRouter(async () => ctx.service));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/audit-anchors`, ctx);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("serves receipts and verification without exposing member data", async () => {
    await withServer(async (base) => {
      const receipt = await (await fetch(`${base}/gameweeks/12`)).json();
      assert.equal(receipt.data.status, "CONFIRMED");
      assert.doesNotMatch(JSON.stringify(receipt), /"u1"|"snapshot"|"members"/);

      const verify = await (await fetch(`${base}/gameweeks/12/verify`)).json();
      assert.equal(verify.data.verified, true);
      assert.doesNotMatch(JSON.stringify(verify), /"u1"|"snapshot"|"members"/);

      const list = await (await fetch(`${base}/gameweeks`)).json();
      assert.equal(list.data.length, 1);
    });
  });

  it("returns 404 for unanchored gameweeks and 400 for invalid input", async () => {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/gameweeks/99`)).status, 404);
      assert.equal((await fetch(`${base}/gameweeks/99/verify`)).status, 404);
      assert.equal((await fetch(`${base}/gameweeks/abc`)).status, 400);
      assert.equal((await fetch(`${base}/gameweeks/abc/verify`)).status, 400);
    });
  });
});
