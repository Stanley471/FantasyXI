/**
 * Zero-knowledge range proofs for private high-roller league deposits.
 *
 * A depositor commits to their stake `v` with a Pedersen commitment over the
 * prime-order ristretto255 group,
 *
 *     C = v·G + r·H
 *
 * where `H` is derived by hash-to-curve so nobody knows log_G(H). They then
 * prove `min <= v <= max` without revealing `v` by proving that both
 * `v - min` and `max - v` lie in [0, 2^n) with n = bitLength(max - min):
 *
 *   - each side is decomposed into n bit commitments C_i = b_i·G + r_i·H whose
 *     weighted sum Σ 2^i·C_i must equal C - min·G (resp. max·G - C), and
 *   - each C_i carries a Fiat–Shamir CDS OR-proof that it commits to 0 or 1.
 *
 * Since 2·2^n is far below the group order, the two non-negativity proofs pin
 * v to [min, max]. Every challenge is bound to the statement (league/user
 * context, bounds, commitment, side and bit index), so a proof cannot be
 * replayed for another league, user or range.
 *
 * Proofs are O(n) in size (no trusted setup); for the ≤ 64-bit stroop ranges
 * used here that is at most 2 × 64 bit proofs.
 */

import crypto from "node:crypto";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";

type Point = InstanceType<typeof ristretto255.Point>;

const Point = ristretto255.Point;
const L = Point.Fn.ORDER;
const G = Point.BASE;
const H = ristretto255_hasher.hashToCurve(new TextEncoder().encode("FantasyXI/pedersen/H/v1"));
const DOMAIN = "FantasyXI/deposit-range-proof/v1";

/** Upper bound on n, which also bounds proof size and verification cost. */
export const MAX_RANGE_BITS = 64;

export interface BitProof {
  /** Bit commitment C_i (32-byte ristretto255 encoding, hex) */
  c: string;
  /** OR-proof challenges and responses (32-byte little-endian scalars, hex) */
  e0: string;
  e1: string;
  s0: string;
  s1: string;
}

export interface DepositRangeProof {
  /** Pedersen commitment to the deposit amount (hex) */
  commitment: string;
  /** Bits of v - min */
  low: BitProof[];
  /** Bits of max - v */
  high: BitProof[];
}

export interface RangeStatement {
  /** Inclusive bounds, in stroops */
  min: bigint;
  max: bigint;
  /** Binds the proof to its use, e.g. `${leagueId}:${userId}` */
  context: string;
}

export type RangeProofVerification =
  | { valid: true; commitment: string }
  | { valid: false; reason: string };

type Side = "low" | "high";

const mod = (a: bigint): bigint => ((a % L) + L) % L;

/** Constant-time multiplication, for secret scalars (prover). */
function mul(point: Point, scalar: bigint): Point {
  const k = mod(scalar);
  return k === 0n ? Point.ZERO : point.multiply(k);
}

/** Variable-time multiplication, for public data only (verifier). */
const mulPublic = (point: Point, scalar: bigint): Point => point.multiplyUnsafe(mod(scalar));

function randomScalar(): bigint {
  return mod(BigInt(`0x${crypto.randomBytes(64).toString("hex")}`));
}

function scalarToHex(k: bigint): string {
  return Buffer.from(k.toString(16).padStart(64, "0"), "hex").reverse().toString("hex");
}

function scalarFromHex(hex: unknown): bigint {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("malformed scalar");
  const k = BigInt(`0x${Buffer.from(hex, "hex").reverse().toString("hex")}`);
  if (k >= L) throw new Error("non-canonical scalar");
  return k;
}

function pointFromHex(hex: unknown): Point {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("malformed point");
  return Point.fromBytes(Buffer.from(hex, "hex"));
}

const pointHex = (p: Point): string => Buffer.from(p.toBytes()).toString("hex");

/** Number of bits needed to represent max - min. */
export function rangeBitLength(min: bigint, max: bigint): number {
  return Math.max(1, (max - min).toString(2).length);
}

function assertStatement({ min, max }: RangeStatement): number {
  if (min < 0n || max < min) throw new Error("Invalid range: require 0 <= min <= max");
  const n = rangeBitLength(min, max);
  if (n > MAX_RANGE_BITS) throw new Error(`Range exceeds ${MAX_RANGE_BITS} bits`);
  return n;
}

/** Pedersen commitment v·G + r·H. */
export function commitDeposit(value: bigint, blinding: bigint): Point {
  return mul(G, value).add(mul(H, blinding));
}

function challenge(
  statement: RangeStatement,
  commitment: Point,
  side: Side,
  index: number,
  c: Point,
  a0: Point,
  a1: Point
): bigint {
  const digest = crypto
    .createHash("sha512")
    .update(
      [DOMAIN, statement.context, statement.min, statement.max, side, index]
        .map(String)
        .join("|")
    )
    .update(commitment.toBytes())
    .update(c.toBytes())
    .update(a0.toBytes())
    .update(a1.toBytes())
    .digest("hex");
  return mod(BigInt(`0x${digest}`));
}

/**
 * Proves knowledge of bits of `x` with commitments summing to x·G + blinding·H.
 * Low-level building block of `createDepositRangeProof`; it does not check
 * that 0 <= x < 2^n, which the verifier's sum check enforces.
 */
export function proveBits(
  x: bigint,
  blinding: bigint,
  n: number,
  statement: RangeStatement,
  commitment: Point,
  side: Side
): BitProof[] {
  const weighted = (i: number) => 1n << BigInt(i);
  const blindings = Array.from({ length: n }, (_, i) => (i === 0 ? 0n : randomScalar()));
  blindings[0] = mod(blinding - blindings.reduce((acc, r, i) => acc + weighted(i) * r, 0n));

  return blindings.map((r, i) => {
    const bit = Number((mod(x) >> BigInt(i)) & 1n);
    const c = mul(G, BigInt(bit)).add(mul(H, r));
    const p = [c, c.subtract(G)];

    // Simulate the false branch, prove the true one.
    const other = 1 - bit;
    const eOther = randomScalar();
    const sOther = randomScalar();
    const k = randomScalar();
    const a: Point[] = [];
    a[bit] = mul(H, k);
    a[other] = mul(H, sOther).subtract(mul(p[other], eOther));

    const e = challenge(statement, commitment, side, i, c, a[0], a[1]);
    const eReal = mod(e - eOther);
    const sReal = mod(k + eReal * r);
    const es = bit === 0 ? [eReal, eOther] : [eOther, eReal];
    const ss = bit === 0 ? [sReal, sOther] : [sOther, sReal];
    return {
      c: pointHex(c),
      e0: scalarToHex(es[0]),
      e1: scalarToHex(es[1]),
      s0: scalarToHex(ss[0]),
      s1: scalarToHex(ss[1]),
    };
  });
}

/**
 * Client-side prover: commits to `value` and proves min <= value <= max.
 * Throws for out-of-range values; the blinding factor must stay private.
 */
export function createDepositRangeProof(
  value: bigint,
  statement: RangeStatement,
  blinding: bigint = randomScalar()
): { proof: DepositRangeProof; blinding: bigint } {
  const n = assertStatement(statement);
  if (value < statement.min || value > statement.max) {
    throw new Error("Deposit amount is outside the league buy-in range");
  }
  const commitment = commitDeposit(value, blinding);
  return {
    blinding,
    proof: {
      commitment: pointHex(commitment),
      low: proveBits(value - statement.min, blinding, n, statement, commitment, "low"),
      high: proveBits(statement.max - value, -blinding, n, statement, commitment, "high"),
    },
  };
}

function verifySide(
  bits: unknown,
  n: number,
  target: Point,
  statement: RangeStatement,
  commitment: Point,
  side: Side
): void {
  if (!Array.isArray(bits) || bits.length !== n) throw new Error(`${side} proof must have ${n} bits`);
  const commitments = bits.map((bit: Record<string, unknown>, i) => {
    if (!bit || typeof bit !== "object") throw new Error(`${side} bit ${i} malformed`);
    const c = pointFromHex(bit.c);
    const [e0, e1, s0, s1] = [bit.e0, bit.e1, bit.s0, bit.s1].map(scalarFromHex);
    const a0 = mulPublic(H, s0).subtract(mulPublic(c, e0));
    const a1 = mulPublic(H, s1).subtract(mulPublic(c.subtract(G), e1));
    if (mod(e0 + e1) !== challenge(statement, commitment, side, i, c, a0, a1)) {
      throw new Error(`${side} bit ${i} is not a valid 0/1 commitment`);
    }
    return c;
  });
  // Σ 2^i·C_i via Horner's rule (doublings instead of scalar multiplications).
  const sum = commitments.reduceRight((acc, c) => acc.double().add(c), Point.ZERO);
  if (!sum.equals(target)) throw new Error(`${side} bits do not open to the committed amount`);
}

/**
 * Verifies a deposit range proof. Never throws: any malformed, non-canonical
 * or out-of-range proof yields `{ valid: false }` deterministically.
 */
export function verifyDepositRangeProof(
  proof: unknown,
  statement: RangeStatement
): RangeProofVerification {
  try {
    const n = assertStatement(statement);
    if (!proof || typeof proof !== "object") throw new Error("proof must be an object");
    const { commitment: commitmentHex, low, high } = proof as Record<string, unknown>;
    const commitment = pointFromHex(commitmentHex);
    verifySide(low, n, commitment.subtract(mulPublic(G, statement.min)), statement, commitment, "low");
    verifySide(high, n, mulPublic(G, statement.max).subtract(commitment), statement, commitment, "high");
    return { valid: true, commitment: pointHex(commitment) };
  } catch (error) {
    return { valid: false, reason: (error as Error).message };
  }
}
