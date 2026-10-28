import crypto, { KeyObject } from "crypto";
import jwt from "jsonwebtoken";

/**
 * In-memory ring of asymmetric JWT signing keys (issue #332).
 *
 * Every access token is signed with ES256 (ECDSA P-256 + SHA-256, RFC 7518
 * section 3.4) and carries the signing key's `kid` header (RFC 7515 section
 * 4.1.4). Verification looks the key up by `kid`, so tokens signed with a
 * previous key keep verifying until that key's grace window (`retiresAt`)
 * ends, and a revoked key fails verification as soon as it leaves the ring.
 *
 * The ring does no I/O: sign and verify stay synchronous, so the HTTP
 * middleware and WebSocket handlers that call them are unchanged. Loading keys
 * from the database, rotating them and fanning out revocations across nodes is
 * the job of JwtKeyRotationService.
 *
 * Complexity, for k keys in the ring (k is about 2-3: current, next, and one
 * in its grace window): verify is an O(1) Map lookup plus one ECDSA
 * verification; sign is O(k) to pick the signing key; JWKS export is O(k).
 */

export const JWT_SIGNING_ALGORITHM = "ES256" as const;
const LEGACY_ALGORITHM = "HS256" as const;

export interface JwtSigningKey {
  kid: string;
  publicKey: KeyObject;
  /** Absent for keys this node can only verify with. */
  privateKey: KeyObject | null;
  /** Epoch ms from which the key may sign. Keys are published before this. */
  activatesAt: number;
  /** Epoch ms after which tokens signed by this key are rejected; null while current. */
  retiresAt: number | null;
}

/** Public JWK of a P-256 signing key, as published in the JWK Set (RFC 7517). */
export interface PublicSigningJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  use: "sig";
  alg: typeof JWT_SIGNING_ALGORITHM;
}

export interface JwtKeyRingOptions {
  now?: () => number;
  /** Shared secret for HS256 tokens issued before asymmetric signing; null disables them. */
  legacySecret?: () => string | null;
  /** Generate a process-local key when the ring is empty (development and tests only). */
  allowEphemeralKeys?: boolean;
}

/** Creates a fresh P-256 key pair with a random, URL-safe key ID. */
export function generateSigningKeyPair(): { kid: string; publicKey: KeyObject; privateKey: KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid: crypto.randomBytes(16).toString("base64url"), publicKey, privateKey };
}

export function toPublicJwk(kid: string, publicKey: KeyObject): PublicSigningJwk {
  const jwk = publicKey.export({ format: "jwk" });
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x as string,
    y: jwk.y as string,
    kid,
    use: "sig",
    alg: JWT_SIGNING_ALGORITHM,
  };
}

export class JwtKeyRing {
  private keys = new Map<string, JwtSigningKey>();
  private unknownKidListener: ((kid: string) => void) | null = null;
  private readonly now: () => number;
  private readonly legacySecret: () => string | null;
  private readonly allowEphemeralKeys: boolean;

  constructor(options: JwtKeyRingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.legacySecret = options.legacySecret ?? (() => null);
    this.allowEphemeralKeys = options.allowEphemeralKeys ?? false;
  }

  /** Atomically replaces the ring's contents with the given keys. */
  public replaceAll(keys: JwtSigningKey[]): void {
    this.keys = new Map(keys.map((key) => [key.kid, key]));
  }

  /** Drops a key immediately; tokens carrying its kid stop verifying. */
  public remove(kid: string): void {
    this.keys.delete(kid);
  }

  public has(kid: string): boolean {
    return this.keys.has(kid);
  }

  public get size(): number {
    return this.keys.size;
  }

  /**
   * Called (synchronously) when a token names a kid this node does not hold,
   * e.g. a key another node just activated. The rotation service uses it to
   * trigger a refresh from the database.
   */
  public onUnknownKid(listener: ((kid: string) => void) | null): void {
    this.unknownKidListener = listener;
  }

  /** The key new tokens are signed with: the most recently activated usable key. */
  public currentSigningKey(): JwtSigningKey | null {
    const now = this.now();
    let current: JwtSigningKey | null = null;
    for (const key of this.keys.values()) {
      if (!key.privateKey || key.activatesAt > now || this.isRetired(key, now)) continue;
      if (!current || key.activatesAt > current.activatesAt) current = key;
    }
    return current;
  }

  public sign(payload: object, expiresIn: jwt.SignOptions["expiresIn"]): string {
    let key = this.currentSigningKey();
    if (!key && this.allowEphemeralKeys && this.keys.size === 0) {
      const generated = generateSigningKeyPair();
      key = { ...generated, activatesAt: this.now(), retiresAt: null };
      this.keys.set(key.kid, key);
    }
    if (!key?.privateKey) {
      throw new Error("No active JWT signing key is loaded; was the key rotation service started?");
    }
    return jwt.sign(payload, key.privateKey, {
      algorithm: JWT_SIGNING_ALGORITHM,
      keyid: key.kid,
      expiresIn,
    });
  }

  /**
   * Verifies a token and returns its payload. Throws jsonwebtoken's
   * JsonWebTokenError / TokenExpiredError, which callers already handle.
   */
  public verify(token: string): jwt.JwtPayload {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded.payload === "string") {
      throw new jwt.JsonWebTokenError("jwt malformed");
    }

    const kid = decoded.header.kid;
    if (!kid) return this.verifyLegacy(token);

    const key = this.keys.get(kid);
    if (!key) {
      this.unknownKidListener?.(kid);
      throw new jwt.JsonWebTokenError("jwt signing key is unknown or revoked");
    }
    if (this.isRetired(key, this.now())) {
      throw new jwt.JsonWebTokenError("jwt signing key is retired");
    }

    // Pinning the algorithm prevents alg-confusion attacks (e.g. HS256 signed
    // with the public key, or "none").
    return jwt.verify(token, key.publicKey, { algorithms: [JWT_SIGNING_ALGORITHM] }) as jwt.JwtPayload;
  }

  /** Public JWKs of every key that can currently sign or verify, newest first. */
  public publicJwks(): PublicSigningJwk[] {
    const now = this.now();
    return [...this.keys.values()]
      .filter((key) => !this.isRetired(key, now))
      .sort((a, b) => b.activatesAt - a.activatesAt)
      .map((key) => toPublicJwk(key.kid, key.publicKey));
  }

  private isRetired(key: JwtSigningKey, now: number): boolean {
    return key.retiresAt !== null && now >= key.retiresAt;
  }

  /** HS256 tokens without a kid, accepted only during the configured migration window. */
  private verifyLegacy(token: string): jwt.JwtPayload {
    const secret = this.legacySecret();
    if (!secret) {
      throw new jwt.JsonWebTokenError("jwt has no key ID and legacy tokens are no longer accepted");
    }
    return jwt.verify(token, secret, { algorithms: [LEGACY_ALGORITHM] }) as jwt.JwtPayload;
  }
}
