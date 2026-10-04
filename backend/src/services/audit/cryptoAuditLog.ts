import crypto from "crypto";

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

export interface CryptoAuditEntry {
  id: string;
  sequence: number;
  action: string; // e.g., "SQUAD_TRANSFER", "USDC_DEPOSIT", "LEAGUE_SETTINGS_UPDATE"
  actorId: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  timestamp: string; // ISO 8601 UTC
  previousHash: string;
  hash: string;
}

export interface VerificationResult {
  valid: boolean;
  totalEntries: number;
  tamperedIndex?: number;
  error?: string;
  lastVerifiedHash?: string;
}

/**
 * Deterministically serialize payload object to prevent false-positive tampering due to key ordering.
 */
export function canonicalizePayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object") {
    return JSON.stringify(payload);
  }
  if (Array.isArray(payload)) {
    return `[${payload.map(canonicalizePayload).join(",")}]`;
  }
  const keys = Object.keys(payload as Record<string, unknown>).sort();
  const sortedPairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizePayload((payload as any)[k])}`
  );
  return `{${sortedPairs.join(",")}}`;
}

/**
 * Calculates SHA-256 hash chaining previousHash, payload, timestamp, and actorId.
 */
export function calculateAuditHash(
  previousHash: string,
  payload: unknown,
  timestamp: string,
  actorId: string
): string {
  const canonical = canonicalizePayload(payload);
  const dataToHash = `${previousHash}|${canonical}|${timestamp}|${actorId}`;
  return crypto.createHash("sha256").update(dataToHash, "utf8").digest("hex");
}

export class CryptographicAuditLog {
  private chain: CryptoAuditEntry[] = [];
  private currentHash: string = GENESIS_HASH;

  constructor(initialEntries?: CryptoAuditEntry[]) {
    if (initialEntries && initialEntries.length > 0) {
      this.chain = [...initialEntries];
      this.currentHash = this.chain[this.chain.length - 1].hash;
    }
  }

  /**
   * Appends a new immutable mutation record to the cryptographic hash chain.
   */
  public record(
    action: string,
    actorId: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>,
    customTimestamp?: string
  ): CryptoAuditEntry {
    const timestamp = customTimestamp || new Date().toISOString();
    const previousHash = this.currentHash;
    const hash = calculateAuditHash(previousHash, payload, timestamp, actorId);
    const sequence = this.chain.length + 1;
    const id = `audit_${sequence}_${Date.now()}`;

    const entry: CryptoAuditEntry = {
      id,
      sequence,
      action,
      actorId,
      entityType,
      entityId,
      payload,
      timestamp,
      previousHash,
      hash,
    };

    this.chain.push(entry);
    this.currentHash = hash;
    return entry;
  }

  public getChain(): CryptoAuditEntry[] {
    return [...this.chain];
  }

  public getLatestHash(): string {
    return this.currentHash;
  }

  /**
   * Verifies mathematical hash continuity from genesis to latest.
   */
  public verify(entriesToVerify?: CryptoAuditEntry[]): VerificationResult {
    const chain = entriesToVerify || this.chain;

    if (chain.length === 0) {
      return { valid: true, totalEntries: 0, lastVerifiedHash: GENESIS_HASH };
    }

    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];

      // 1. Verify sequence ordering
      if (entry.sequence !== i + 1) {
        return {
          valid: false,
          totalEntries: chain.length,
          tamperedIndex: i,
          error: `Sequence mismatch at index ${i}: expected ${i + 1}, found ${entry.sequence}`,
        };
      }

      // 2. Verify previousHash matches previous row's hash
      if (entry.previousHash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: chain.length,
          tamperedIndex: i,
          error: `Broken hash continuity at index ${i}: stored previousHash does not match prior entry`,
        };
      }

      // 3. Re-compute hash and verify against stored hash
      const computedHash = calculateAuditHash(
        entry.previousHash,
        entry.payload,
        entry.timestamp,
        entry.actorId
      );

      if (computedHash !== entry.hash) {
        return {
          valid: false,
          totalEntries: chain.length,
          tamperedIndex: i,
          error: `Tampered row detected at index ${i}: computed hash ${computedHash} != stored hash ${entry.hash}`,
        };
      }

      expectedPrevHash = entry.hash;
    }

    return {
      valid: true,
      totalEntries: chain.length,
      lastVerifiedHash: expectedPrevHash,
    };
  }
}

export const cryptoAuditLog = new CryptographicAuditLog();
