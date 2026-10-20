import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  commitDeposit,
  createDepositRangeProof,
  proveBits,
  rangeBitLength,
  verifyDepositRangeProof,
  type DepositRangeProof,
  type RangeStatement,
} from "../services/financial/depositRangeProof.js";
import {
  PersistentCryptoAuditLog,
  type CryptoAuditEntry,
  type CryptoAuditLogStore,
} from "../services/audit/cryptoAuditLog.js";
import { requireDepositRangeProof, toStroops } from "../middleware/depositRangeProof.js";
import { LeagueService, LeagueValidationError } from "../services/league/leagueService.js";

const statement: RangeStatement = { min: 100n, max: 1_000n, context: "league-1:user-1" };
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** Forges a proof for an out-of-range value by skipping the prover's bounds check. */
function forgeProof(value: bigint, st: RangeStatement): DepositRangeProof {
  const n = rangeBitLength(st.min, st.max);
  const blinding = 12345n;
  const commitment = commitDeposit(value, blinding);
  return {
    commitment: Buffer.from(commitment.toBytes()).toString("hex"),
    low: proveBits(value - st.min, blinding, n, st, commitment, "low"),
    high: proveBits(st.max - value, -blinding, n, st, commitment, "high"),
  };
}

const clone = (proof: DepositRangeProof): DepositRangeProof => JSON.parse(JSON.stringify(proof));

describe("deposit range proofs", () => {
  const { proof } = createDepositRangeProof(500n, statement);

  it("verifies stakes anywhere in the inclusive range", () => {
    for (const value of [100n, 101n, 500n, 999n, 1_000n]) {
      const result = verifyDepositRangeProof(createDepositRangeProof(value, statement).proof, statement);
      assert.equal(result.valid, true, `value ${value}`);
    }
    // Realistic USDC stroop range (50 – 5,000 USDC).
    const large: RangeStatement = { min: 500_000_000n, max: 50_000_000_000n, context: "hr:u" };
    assert.equal(
      verifyDepositRangeProof(createDepositRangeProof(12_345_678_901n, large).proof, large).valid,
      true
    );
  });

  it("refuses to prove out-of-range stakes", () => {
    for (const value of [0n, 99n, 1_001n]) {
      assert.throws(() => createDepositRangeProof(value, statement), /outside the league buy-in range/);
    }
  });

  it("rejects forged proofs for out-of-bound amounts deterministically", () => {
    for (const value of [99n, 0n, 1_001n, 5_000n]) {
      const forged = forgeProof(value, statement);
      const first = verifyDepositRangeProof(forged, statement);
      const second = verifyDepositRangeProof(forged, statement);
      assert.equal(first.valid, false, `value ${value}`);
      assert.deepEqual(first, second);
    }
  });

  it("binds proofs to their league/user context and bounds", () => {
    assert.equal(verifyDepositRangeProof(proof, statement).valid, true);
    assert.equal(verifyDepositRangeProof(proof, { ...statement, context: "league-2:user-1" }).valid, false);
    assert.equal(verifyDepositRangeProof(proof, { ...statement, context: "league-1:user-2" }).valid, false);
    assert.equal(verifyDepositRangeProof(proof, { ...statement, min: 101n }).valid, false);
    assert.equal(verifyDepositRangeProof(proof, { ...statement, max: 2_000n }).valid, false);
  });

  it("rejects malformed inputs without throwing", () => {
    const mutate = (fn: (p: DepositRangeProof) => void) => {
      const copy = clone(proof);
      fn(copy);
      return copy;
    };
    const flipHex = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
    const nonCanonical = Buffer.from(L.toString(16).padStart(64, "0"), "hex").reverse().toString("hex");

    const cases: unknown[] = [
      undefined,
      null,
      "proof",
      42,
      [],
      {},
      { commitment: proof.commitment },
      { ...proof, commitment: "zz".repeat(32) },
      { ...proof, commitment: "ff".repeat(32) },
      { ...proof, commitment: proof.commitment.slice(2) },
      { ...proof, low: proof.low.slice(1) },
      { ...proof, high: [...proof.high, proof.high[0]] },
      { ...proof, low: proof.low.map(() => null) },
      { ...proof, low: "bits" },
      mutate((p) => (p.low[0].e0 = flipHex(p.low[0].e0))),
      mutate((p) => (p.high[3].s1 = flipHex(p.high[3].s1))),
      mutate((p) => (p.low[2].c = p.low[3].c)),
      mutate((p) => (p.low[0].s0 = nonCanonical)),
      mutate((p) => (p.low[0].e1 = "not-hex")),
      mutate((p) => ([p.low, p.high] = [p.high, p.low])),
      mutate((p) => (p.commitment = createDepositRangeProof(500n, statement).proof.commitment)),
    ];
    for (const [index, input] of cases.entries()) {
      const result = verifyDepositRangeProof(input, statement);
      assert.equal(result.valid, false, `case ${index}`);
    }
  });

  it("rejects invalid statements", () => {
    assert.equal(verifyDepositRangeProof(proof, { ...statement, min: 2_000n }).valid, false);
    assert.equal(verifyDepositRangeProof(proof, { ...statement, min: -1n }).valid, false);
    assert.equal(verifyDepositRangeProof(proof, { ...statement, max: 2n ** 70n }).valid, false);
  });
});

/** In-memory stand-in for the `crypto_audit_log` table. */
function memoryStore(): CryptoAuditLogStore & { rows: CryptoAuditEntry[] } {
  const rows: CryptoAuditEntry[] = [];
  return {
    rows,
    cryptoAuditLogEntry: {
      findFirst: async () => rows.at(-1) ?? null,
      findMany: async () => [...rows],
      create: async ({ data }) => {
        if (rows.some((row) => row.sequence === data.sequence)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `row-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
    },
  };
}

describe("PersistentCryptoAuditLog", () => {
  it("persists a verifiable hash chain and detects tampering", async () => {
    const store = memoryStore();
    const log = new PersistentCryptoAuditLog(store);
    await log.append("A", "u1", "League", "l1", { commitment: "aa" });
    await log.append("B", "u2", "League", "l1", { commitment: "bb" });
    await log.append("C", "u3", "League", "l2", { commitment: "cc" });
    assert.equal((await log.verify()).valid, true);
    assert.equal(store.rows[1].previousHash, store.rows[0].hash);

    store.rows[1].payload = { commitment: "tampered" };
    const result = await log.verify();
    assert.equal(result.valid, false);
    assert.equal(result.tamperedIndex, 1);
  });

  it("retries an append that lost a race on the chain head", async () => {
    const store = memoryStore();
    const log = new PersistentCryptoAuditLog(store);
    await log.append("A", "u1", "League", "l1", {});
    const realFindFirst = store.cryptoAuditLogEntry.findFirst;
    let calls = 0;
    // First read returns a stale (genesis) head, as if another writer won the race.
    store.cryptoAuditLogEntry.findFirst = async (args) => (calls++ === 0 ? null : realFindFirst(args));
    await log.append("B", "u2", "League", "l1", {});
    assert.equal(store.rows.length, 2);
    assert.equal((await log.verify()).valid, true);
  });
});

describe("requireDepositRangeProof middleware", () => {
  const range = { isPrivate: true, minBuyIn: "0.00001", maxBuyIn: "0.0001" };
  const mwStatement: RangeStatement = { min: 100n, max: 1_000n, context: "league-1:user-1" };

  function run(league: unknown, body: unknown) {
    const audit: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const middleware = requireDepositRangeProof({
      db: { league: { findUnique: async () => league as never } },
      auditLog: { append: async (action, _a, _t, _e, payload) => (audit.push({ action, payload }), {} as never) },
    });
    const response = { statusCode: 200, body: undefined as unknown, locals: {} as Record<string, unknown> };
    return new Promise<{ response: typeof response; audit: typeof audit; nextCalled: boolean }>(
      (resolve, reject) => {
        const res: any = {
          locals: response.locals,
          status(code: number) {
            response.statusCode = code;
            return this;
          },
          json(payload: unknown) {
            response.body = payload;
            resolve({ response, audit, nextCalled: false });
            return this;
          },
        };
        const req: any = { params: { leagueId: "league-1" }, user: { id: "user-1" }, body };
        void middleware(req, res, (err?: unknown) =>
          err ? reject(err) : resolve({ response, audit, nextCalled: true })
        );
      }
    );
  }

  it("converts 2-decimal USDC to stroops exactly", () => {
    assert.equal(toStroops("12.34"), 123_400_000n);
    assert.equal(toStroops("0.00001"), 100n);
    assert.equal(toStroops(5), 50_000_000n);
  });

  it("passes through leagues without a buy-in range", async () => {
    const { nextCalled, audit } = await run({ isPrivate: false, minBuyIn: null, maxBuyIn: null }, {});
    assert.equal(nextCalled, true);
    assert.equal(audit.length, 0);
  });

  it("accepts a valid proof and logs only the commitment", async () => {
    const { proof } = createDepositRangeProof(777n, mwStatement);
    const { nextCalled, audit, response } = await run(range, { rangeProof: proof });
    assert.equal(nextCalled, true);
    assert.equal(response.locals.depositCommitment, proof.commitment);
    assert.equal(audit[0].action, "DEPOSIT_RANGE_PROOF_VERIFIED");
    assert.equal(audit[0].payload.commitment, proof.commitment);
    assert.doesNotMatch(JSON.stringify(audit[0].payload), /777/);
  });

  it("rejects a missing or out-of-range proof with 422 and audits the rejection", async () => {
    for (const body of [{}, { rangeProof: forgeProof(5_000n, mwStatement) }]) {
      const { nextCalled, audit, response } = await run(range, body);
      assert.equal(nextCalled, false);
      assert.equal(response.statusCode, 422);
      assert.equal(audit[0].action, "DEPOSIT_RANGE_PROOF_REJECTED");
      assert.equal(audit[0].payload.commitment, null);
    }
  });
});

describe("league buy-in range configuration", () => {
  const base = {
    name: "High Rollers",
    entryFee: 50,
    startGameweekId: 1,
    endGameweekId: 2,
    squadId: "squad-1",
  };

  it("rejects buy-in ranges on public leagues and invalid bounds before touching the database", async () => {
    const service = new LeagueService({});
    const cases = [
      { ...base, minBuyIn: 10, maxBuyIn: 100 },
      { ...base, isPrivate: true, minBuyIn: 10 },
      { ...base, isPrivate: true, minBuyIn: 0, maxBuyIn: 100 },
      { ...base, isPrivate: true, minBuyIn: 100, maxBuyIn: 10 },
      { ...base, isPrivate: true, minBuyIn: Number.NaN, maxBuyIn: 10 },
    ];
    for (const input of cases) {
      await assert.rejects(service.createLeague("user-1", input), LeagueValidationError);
    }
  });
});
