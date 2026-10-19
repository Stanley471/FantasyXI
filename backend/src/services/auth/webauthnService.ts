import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/db.js";
import { signAccessToken } from "../../config/jwt.js";
import { PasskeySummary, SafeUser, UserRole } from "../../types/index.js";
import {
  AuthConflictError,
  AuthNotFoundError,
  AuthUnauthorizedError,
  AuthValidationError,
  AuthRequestContext,
} from "./authService.js";
import {
  LoginSecurityService,
  loginSecurityService as defaultLoginSecurityService,
} from "../security/loginSecurityService.js";

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  expectedOrigins: string[];
  challengeTtlMs: number;
}

interface StoredChallenge {
  challenge: string;
  purpose: "registration" | "authentication";
  userId?: string;
  expiresAt: number;
}

export interface RegistrationResponseJSON {
  id: string;
  rawId?: string;
  type?: string;
  name?: string;
  transports?: string[];
  authenticatorAttachment?: string;
  response: {
    clientDataJSON: string;
    attestationObject?: string;
    /** Base64url or PEM public key from AuthenticatorAttestationResponse.getPublicKey() */
    publicKey?: string;
    publicKeyAlgorithm?: number;
    transports?: string[];
  };
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId?: string;
  type?: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
}

function defaultWebAuthnConfig(): WebAuthnConfig {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  let defaultRpId = "localhost";
  try {
    defaultRpId = new URL(frontendUrl).hostname || "localhost";
  } catch {
    defaultRpId = "localhost";
  }

  const rpId = process.env.WEBAUTHN_RP_ID || defaultRpId;
  const rpName = process.env.WEBAUTHN_RP_NAME || "FantasyXI";
  const originsEnv = process.env.WEBAUTHN_ORIGIN;
  const expectedOrigins = originsEnv
    ? originsEnv.split(",").map((o) => o.trim()).filter(Boolean)
    : [frontendUrl, `https://${rpId}`, `http://${rpId}:3000`, `http://${rpId}`];

  return {
    rpId,
    rpName,
    expectedOrigins: Array.from(new Set(expectedOrigins)),
    challengeTtlMs: 5 * 60 * 1000,
  };
}

export function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

function sha256(data: Buffer | string): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

/**
 * Minimal CBOR decoder for WebAuthn attestationObject and COSE public keys.
 * Supports Major types 0 (uint), 1 (nint), 2 (bstr), 3 (tstr), 4 (array), 5 (map), 7 (simple/bool/null).
 */
export function decodeCborItem(buf: Buffer, offset = 0): { value: any; offset: number } {
  if (offset >= buf.length) {
    throw new AuthValidationError("Malformed CBOR payload: unexpected end of buffer");
  }

  const initialByte = buf[offset++];
  const majorType = initialByte >> 5;
  const additionalInfo = initialByte & 0x1f;

  const readLength = (): number => {
    if (additionalInfo < 24) return additionalInfo;
    if (additionalInfo === 24) {
      if (offset + 1 > buf.length) throw new AuthValidationError("Malformed CBOR uint8");
      return buf[offset++];
    }
    if (additionalInfo === 25) {
      if (offset + 2 > buf.length) throw new AuthValidationError("Malformed CBOR uint16");
      const val = buf.readUInt16BE(offset);
      offset += 2;
      return val;
    }
    if (additionalInfo === 26) {
      if (offset + 4 > buf.length) throw new AuthValidationError("Malformed CBOR uint32");
      const val = buf.readUInt32BE(offset);
      offset += 4;
      return val;
    }
    if (additionalInfo === 27) {
      if (offset + 8 > buf.length) throw new AuthValidationError("Malformed CBOR uint64");
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      return Number(big);
    }
    throw new AuthValidationError(`Unsupported CBOR additional info: ${additionalInfo}`);
  };

  switch (majorType) {
    case 0: // unsigned integer
      return { value: readLength(), offset };
    case 1: // negative integer
      return { value: -1 - readLength(), offset };
    case 2: {
      // byte string
      const len = readLength();
      if (offset + len > buf.length) throw new AuthValidationError("Malformed CBOR byte string");
      const slice = buf.subarray(offset, offset + len);
      offset += len;
      return { value: Buffer.from(slice), offset };
    }
    case 3: {
      // text string
      const len = readLength();
      if (offset + len > buf.length) throw new AuthValidationError("Malformed CBOR text string");
      const str = buf.subarray(offset, offset + len).toString("utf8");
      offset += len;
      return { value: str, offset };
    }
    case 4: {
      // array
      const len = readLength();
      const arr: any[] = [];
      for (let i = 0; i < len; i++) {
        const decoded = decodeCborItem(buf, offset);
        arr.push(decoded.value);
        offset = decoded.offset;
      }
      return { value: arr, offset };
    }
    case 5: {
      // map
      const len = readLength();
      const map = new Map<any, any>();
      for (let i = 0; i < len; i++) {
        const k = decodeCborItem(buf, offset);
        offset = k.offset;
        const v = decodeCborItem(buf, offset);
        offset = v.offset;
        map.set(k.value, v.value);
      }
      return { value: map, offset };
    }
    case 7: {
      if (additionalInfo === 20) return { value: false, offset };
      if (additionalInfo === 21) return { value: true, offset };
      if (additionalInfo === 22 || additionalInfo === 23) return { value: null, offset };
      return { value: null, offset };
    }
    default:
      throw new AuthValidationError(`Unsupported CBOR major type: ${majorType}`);
  }
}

/**
 * Converts a COSE_Key Map (RFC 8152) into a Node KeyObject PEM string and algorithm identifier.
 */
function coseKeyToPem(coseMap: Map<any, any>): { publicKeyPem: string; algorithm: number } {
  const kty = coseMap.get(1);
  const alg = Number(coseMap.get(3) ?? -7);

  // EC2 key (kty = 2, e.g., P-256 / ES256 alg = -7)
  if (kty === 2) {
    const x: Buffer | undefined = coseMap.get(-2);
    const y: Buffer | undefined = coseMap.get(-3);
    if (!x || !y || x.length !== 32 || y.length !== 32) {
      throw new AuthValidationError("Invalid COSE EC2 public key coordinates");
    }
    const keyObj = crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(x),
        y: toBase64Url(y),
      },
      format: "jwk",
    });
    return {
      publicKeyPem: keyObj.export({ type: "spki", format: "pem" }).toString(),
      algorithm: alg || -7,
    };
  }

  // OKP key (kty = 1, e.g., Ed25519 / EdDSA alg = -8)
  if (kty === 1) {
    const x: Buffer | undefined = coseMap.get(-2);
    if (!x || x.length !== 32) {
      throw new AuthValidationError("Invalid COSE OKP Ed25519 public key");
    }
    const keyObj = crypto.createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: toBase64Url(x),
      },
      format: "jwk",
    });
    return {
      publicKeyPem: keyObj.export({ type: "spki", format: "pem" }).toString(),
      algorithm: alg || -8,
    };
  }

  // RSA key (kty = 3, e.g., RS256 alg = -257)
  if (kty === 3) {
    const n: Buffer | undefined = coseMap.get(-1);
    const e: Buffer | undefined = coseMap.get(-2);
    if (!n || !e) {
      throw new AuthValidationError("Invalid COSE RSA public key parameters");
    }
    const keyObj = crypto.createPublicKey({
      key: {
        kty: "RSA",
        n: toBase64Url(n),
        e: toBase64Url(e),
      },
      format: "jwk",
    });
    return {
      publicKeyPem: keyObj.export({ type: "spki", format: "pem" }).toString(),
      algorithm: alg || -257,
    };
  }

  throw new AuthValidationError(`Unsupported COSE key type: ${String(kty)}`);
}

/**
 * Normalizes any supported public key representation (PEM, SPKI base64url, JWK JSON, or COSE CBOR)
 * into a canonical SPKI PEM string.
 */
function normalizePublicKeyToPem(
  rawPublicKey: string,
  fallbackAlgorithm = -7
): { publicKeyPem: string; algorithm: number } {
  const trimmed = rawPublicKey.trim();

  if (trimmed.startsWith("-----BEGIN")) {
    const keyObj = crypto.createPublicKey(trimmed);
    return {
      publicKeyPem: keyObj.export({ type: "spki", format: "pem" }).toString(),
      algorithm: fallbackAlgorithm,
    };
  }

  if (trimmed.startsWith("{")) {
    const jwk = JSON.parse(trimmed);
    const keyObj = crypto.createPublicKey({ key: jwk, format: "jwk" });
    return {
      publicKeyPem: keyObj.export({ type: "spki", format: "pem" }).toString(),
      algorithm: fallbackAlgorithm,
    };
  }

  const derOrCose = fromBase64Url(trimmed);
  try {
    const keyObj = crypto.createPublicKey({ key: derOrCose, format: "der", type: "spki" });
    return {
      publicKeyPem: keyObj.export({ type: "spki", format: "pem" }).toString(),
      algorithm: fallbackAlgorithm,
    };
  } catch {
    const decoded = decodeCborItem(derOrCose);
    if (decoded.value instanceof Map) {
      return coseKeyToPem(decoded.value);
    }
    throw new AuthValidationError("Unsupported public key format");
  }
}

/**
 * Converts a 64-byte IEEE P1363 ECDSA signature (r || s) into ASN.1 DER if needed,
 * or returns an existing DER signature as-is.
 */
function ensureDerEcdsaSignature(sig: Buffer): Buffer {
  // ASN.1 SEQUENCE tag is 0x30
  if (sig.length > 0 && sig[0] === 0x30 && sig.length !== 64) {
    return sig;
  }
  if (sig.length === 64) {
    const encodeInt = (part: Buffer): Buffer => {
      let i = 0;
      while (i < part.length - 1 && part[i] === 0) i++;
      const sliced = part.subarray(i);
      if (sliced[0] & 0x80) {
        return Buffer.concat([Buffer.from([0x02, sliced.length + 1, 0x00]), sliced]);
      }
      return Buffer.concat([Buffer.from([0x02, sliced.length]), sliced]);
    };
    const rDer = encodeInt(sig.subarray(0, 32));
    const sDer = encodeInt(sig.subarray(32, 64));
    const totalLen = rDer.length + sDer.length;
    return Buffer.concat([Buffer.from([0x30, totalLen]), rDer, sDer]);
  }
  return sig;
}

function toPasskeySummary(record: {
  id: string;
  credentialId: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}): PasskeySummary {
  return {
    id: record.id,
    credentialId: record.credentialId,
    name: record.name,
    deviceType: record.deviceType,
    backedUp: record.backedUp,
    transports: record.transports,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function toSafeUserWithPasskeys(
  user: {
    id: string;
    email: string;
    username: string;
    name: string | null;
    role?: UserRole | string;
    passwordHash?: string | null;
    password?: string | null;
    googleId?: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  hasPasskeys: boolean
): SafeUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    role: (user.role as UserRole) ?? UserRole.USER,
    authProviders: {
      password: Boolean(user.passwordHash ?? user.password),
      google: Boolean(user.googleId),
      ...(hasPasskeys ? { passkeys: true } : {}),
    },
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export class WebAuthnService {
  private readonly prisma: PrismaClient;
  private readonly loginSecurity: LoginSecurityService;
  private readonly config: WebAuthnConfig;
  private readonly challenges = new Map<string, StoredChallenge>();

  constructor(
    prisma: PrismaClient = defaultPrisma,
    loginSecurity: LoginSecurityService = defaultLoginSecurityService,
    config?: Partial<WebAuthnConfig>
  ) {
    this.prisma = prisma;
    this.loginSecurity = loginSecurity;
    this.config = { ...defaultWebAuthnConfig(), ...config };
  }

  private pruneExpiredChallenges(): void {
    const now = Date.now();
    for (const [key, entry] of this.challenges.entries()) {
      if (entry.expiresAt <= now) {
        this.challenges.delete(key);
      }
    }
  }

  private createChallenge(purpose: "registration" | "authentication", userId?: string): string {
    this.pruneExpiredChallenges();
    const challenge = toBase64Url(crypto.randomBytes(32));
    this.challenges.set(challenge, {
      challenge,
      purpose,
      userId,
      expiresAt: Date.now() + this.config.challengeTtlMs,
    });
    return challenge;
  }

  private consumeChallenge(
    challenge: string,
    purpose: "registration" | "authentication",
    userId?: string
  ): StoredChallenge {
    this.pruneExpiredChallenges();
    const entry = this.challenges.get(challenge);
    if (!entry) {
      throw new AuthUnauthorizedError("Invalid or expired WebAuthn challenge");
    }
    this.challenges.delete(challenge);

    if (entry.purpose !== purpose) {
      throw new AuthUnauthorizedError("WebAuthn challenge purpose mismatch");
    }
    if (purpose === "registration" && entry.userId !== userId) {
      throw new AuthUnauthorizedError("WebAuthn challenge user mismatch");
    }
    if (purpose === "authentication" && entry.userId && userId && entry.userId !== userId) {
      throw new AuthUnauthorizedError("WebAuthn challenge user mismatch");
    }
    return entry;
  }

  private verifyClientData(
    clientDataJSONB64: string,
    expectedType: "webauthn.create" | "webauthn.get",
    purpose: "registration" | "authentication",
    userId?: string
  ): { clientDataBuffer: Buffer; challengeEntry: StoredChallenge } {
    if (!clientDataJSONB64 || typeof clientDataJSONB64 !== "string") {
      throw new AuthValidationError("Missing clientDataJSON");
    }

    const clientDataBuffer = fromBase64Url(clientDataJSONB64);
    let parsed: { type?: string; challenge?: string; origin?: string };
    try {
      parsed = JSON.parse(clientDataBuffer.toString("utf8"));
    } catch {
      throw new AuthValidationError("Malformed clientDataJSON");
    }

    if (parsed.type !== expectedType) {
      throw new AuthUnauthorizedError(`Invalid WebAuthn ceremony type: expected ${expectedType}`);
    }

    if (!parsed.challenge || typeof parsed.challenge !== "string") {
      throw new AuthValidationError("Missing challenge in clientDataJSON");
    }

    if (!parsed.origin || !this.config.expectedOrigins.includes(parsed.origin)) {
      throw new AuthUnauthorizedError("Untrusted WebAuthn origin");
    }

    const challengeEntry = this.consumeChallenge(parsed.challenge, purpose, userId);
    return { clientDataBuffer, challengeEntry };
  }

  private verifyAuthenticatorDataHeader(authData: Buffer): {
    flags: number;
    signCount: number;
    userPresent: boolean;
    userVerified: boolean;
    backedUp: boolean;
    deviceType: "singleDevice" | "multiDevice";
    hasAttestedCredData: boolean;
  } {
    if (authData.length < 37) {
      throw new AuthValidationError("Authenticator data is shorter than 37 bytes");
    }

    const rpIdHash = authData.subarray(0, 32);
    const expectedRpIdHash = sha256(this.config.rpId);
    if (!crypto.timingSafeEqual(rpIdHash, expectedRpIdHash)) {
      throw new AuthUnauthorizedError("WebAuthn RP ID hash mismatch");
    }

    const flags = authData[32];
    const userPresent = Boolean(flags & 0x01);
    const userVerified = Boolean(flags & 0x04);
    const backupEligible = Boolean(flags & 0x08);
    const backedUp = Boolean(flags & 0x10);
    const hasAttestedCredData = Boolean(flags & 0x40);

    if (!userPresent) {
      throw new AuthUnauthorizedError("WebAuthn User Present (UP) flag was not set");
    }

    const signCount = authData.readUInt32BE(33);
    return {
      flags,
      signCount,
      userPresent,
      userVerified,
      backedUp,
      deviceType: backupEligible ? "multiDevice" : "singleDevice",
      hasAttestedCredData,
    };
  }

  /**
   * Generates W3C PublicKeyCredentialCreationOptionsJSON for an authenticated user.
   */
  public async generateRegistrationOptions(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AuthNotFoundError("User not found");
    }

    const existingCredentials = await (this.prisma as any).webAuthnCredential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    });

    const challenge = this.createChallenge("registration", userId);

    return {
      challenge,
      rp: {
        name: this.config.rpName,
        id: this.config.rpId,
      },
      user: {
        id: toBase64Url(Buffer.from(user.id, "utf8")),
        name: user.email,
        displayName: user.name || user.username || user.email,
      },
      pubKeyCredParams: [
        { type: "public-key" as const, alg: -7 }, // ES256
        { type: "public-key" as const, alg: -8 }, // EdDSA
        { type: "public-key" as const, alg: -257 }, // RS256
      ],
      timeout: 60000,
      attestation: "none" as const,
      authenticatorSelection: {
        residentKey: "preferred" as const,
        userVerification: "preferred" as const,
      },
      excludeCredentials: existingCredentials.map(
        (cred: { credentialId: string; transports: string[] }) => ({
          id: cred.credentialId,
          type: "public-key" as const,
          transports: cred.transports,
        })
      ),
    };
  }

  /**
   * Verifies a WebAuthn registration ceremony and stores the passkey credential.
   */
  public async verifyRegistration(
    userId: string,
    payload: RegistrationResponseJSON
  ): Promise<{ credential: PasskeySummary; user: SafeUser }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new AuthNotFoundError("User not found");
    }

    if (!payload || typeof payload !== "object" || !payload.response) {
      throw new AuthValidationError("Invalid WebAuthn registration response payload");
    }

    const credentialId = (payload.id || payload.rawId || "").trim();
    if (!credentialId) {
      throw new AuthValidationError("Missing credential ID");
    }

    this.verifyClientData(
      payload.response.clientDataJSON,
      "webauthn.create",
      "registration",
      userId
    );

    const existing = await (this.prisma as any).webAuthnCredential.findUnique({
      where: { credentialId },
    });
    if (existing) {
      throw new AuthConflictError("This passkey is already registered");
    }

    let publicKeyPem: string;
    let algorithm = payload.response.publicKeyAlgorithm ?? -7;
    let signCount = 0;
    let deviceType: "singleDevice" | "multiDevice" = "multiDevice";
    let backedUp = false;

    if (payload.response.attestationObject) {
      const attestationBuf = fromBase64Url(payload.response.attestationObject);
      let authData: Buffer | undefined;

      // Support either CBOR-encoded attestationObject or JSON-encoded attestationObject
      if (attestationBuf.length > 0 && attestationBuf[0] === 0x7b) {
        const parsedAtt = JSON.parse(attestationBuf.toString("utf8"));
        if (parsedAtt.authData) {
          authData = fromBase64Url(parsedAtt.authData);
        }
      } else {
        const decoded = decodeCborItem(attestationBuf);
        if (decoded.value instanceof Map) {
          authData = decoded.value.get("authData");
        }
      }

      if (!authData || !Buffer.isBuffer(authData)) {
        throw new AuthValidationError("Missing authData in attestationObject");
      }

      const header = this.verifyAuthenticatorDataHeader(authData);
      signCount = header.signCount;
      deviceType = header.deviceType;
      backedUp = header.backedUp;

      if (header.hasAttestedCredData && authData.length > 55) {
        // 37 bytes header + 16 bytes AAGUID + 2 bytes credIdLen
        const credIdLen = authData.readUInt16BE(53);
        const credIdEnd = 55 + credIdLen;
        if (credIdEnd > authData.length) {
          throw new AuthValidationError("Malformed attested credential data in authData");
        }
        const attestedCredId = toBase64Url(authData.subarray(55, credIdEnd));
        if (attestedCredId !== credentialId) {
          throw new AuthValidationError("Attested credential ID does not match payload ID");
        }

        const coseKeyBytes = authData.subarray(credIdEnd);
        if (coseKeyBytes.length > 0 && !payload.response.publicKey) {
          const decodedKey = decodeCborItem(coseKeyBytes);
          if (!(decodedKey.value instanceof Map)) {
            throw new AuthValidationError("Malformed COSE public key in authData");
          }
          const converted = coseKeyToPem(decodedKey.value);
          publicKeyPem = converted.publicKeyPem;
          algorithm = converted.algorithm;
        } else if (payload.response.publicKey) {
          const converted = normalizePublicKeyToPem(payload.response.publicKey, algorithm);
          publicKeyPem = converted.publicKeyPem;
          algorithm = converted.algorithm;
        } else {
          throw new AuthValidationError("Missing credential public key");
        }
      } else if (payload.response.publicKey) {
        const converted = normalizePublicKeyToPem(payload.response.publicKey, algorithm);
        publicKeyPem = converted.publicKeyPem;
        algorithm = converted.algorithm;
      } else {
        throw new AuthValidationError("Attestation object missing attested credential data");
      }
    } else if (payload.response.publicKey) {
      const converted = normalizePublicKeyToPem(payload.response.publicKey, algorithm);
      publicKeyPem = converted.publicKeyPem;
      algorithm = converted.algorithm;
    } else {
      throw new AuthValidationError(
        "Registration response must include attestationObject or publicKey"
      );
    }

    const transportsRaw = payload.response.transports ?? payload.transports ?? [];
    const transports = Array.isArray(transportsRaw)
      ? transportsRaw.filter((t): t is string => typeof t === "string")
      : [];

    const existingCount = await (this.prisma as any).webAuthnCredential.count({
      where: { userId },
    });
    const passkeyName =
      typeof payload.name === "string" && payload.name.trim().length > 0
        ? payload.name.trim().slice(0, 64)
        : `Passkey ${existingCount + 1}`;

    const created = await (this.prisma as any).webAuthnCredential.create({
      data: {
        userId,
        credentialId,
        publicKey: publicKeyPem,
        counter: signCount,
        deviceType,
        backedUp,
        transports,
        algorithm,
        name: passkeyName,
      },
    });

    return {
      credential: toPasskeySummary(created),
      user: toSafeUserWithPasskeys(user, true),
    };
  }

  /**
   * Generates W3C PublicKeyCredentialRequestOptionsJSON for passkey sign-in.
   */
  public async generateAuthenticationOptions(input?: { email?: string }) {
    let allowCredentials: Array<{ id: string; type: "public-key"; transports?: string[] }> = [];
    let userId: string | undefined;

    if (input?.email && typeof input.email === "string" && input.email.trim()) {
      const normalizedEmail = input.email.trim().toLowerCase();
      const user = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (user) {
        userId = user.id;
        const credentials = await (this.prisma as any).webAuthnCredential.findMany({
          where: { userId: user.id },
          select: { credentialId: true, transports: true },
        });
        allowCredentials = credentials.map(
          (cred: { credentialId: string; transports: string[] }) => ({
            id: cred.credentialId,
            type: "public-key" as const,
            transports: cred.transports,
          })
        );
      }
    }

    const challenge = this.createChallenge("authentication", userId);

    return {
      challenge,
      rpId: this.config.rpId,
      timeout: 60000,
      userVerification: "preferred" as const,
      allowCredentials,
    };
  }

  /**
   * Verifies a WebAuthn assertion (login) ceremony, updates counter, and issues a JWT session token.
   */
  public async verifyAuthentication(
    payload: AuthenticationResponseJSON,
    meta?: AuthRequestContext
  ): Promise<{ user: SafeUser; token: string }> {
    if (!payload || typeof payload !== "object" || !payload.response) {
      throw new AuthValidationError("Invalid WebAuthn authentication response payload");
    }

    const credentialId = (payload.id || payload.rawId || "").trim();
    if (!credentialId) {
      throw new AuthValidationError("Missing credential ID");
    }

    const storedCredential = await (this.prisma as any).webAuthnCredential.findUnique({
      where: { credentialId },
      include: { user: true },
    });

    if (!storedCredential || !storedCredential.user) {
      throw new AuthUnauthorizedError("Invalid passkey or credential not found");
    }

    const user = storedCredential.user;

    if (payload.response.userHandle) {
      const rawHandle = payload.response.userHandle;
      const decodedHandle = (() => {
        try {
          return fromBase64Url(rawHandle).toString("utf8");
        } catch {
          return rawHandle;
        }
      })();
      if (rawHandle !== user.id && decodedHandle !== user.id) {
        throw new AuthUnauthorizedError("WebAuthn userHandle does not match credential owner");
      }
    }

    const { clientDataBuffer } = this.verifyClientData(
      payload.response.clientDataJSON,
      "webauthn.get",
      "authentication",
      user.id
    );

    if (!payload.response.authenticatorData || !payload.response.signature) {
      throw new AuthValidationError("Missing authenticatorData or signature");
    }

    const authDataBuffer = fromBase64Url(payload.response.authenticatorData);
    const header = this.verifyAuthenticatorDataHeader(authDataBuffer);

    const prevCounter = Number(storedCredential.counter ?? 0);
    if (prevCounter > 0 || header.signCount > 0) {
      if (header.signCount <= prevCounter) {
        throw new AuthUnauthorizedError("Passkey signature counter regression detected");
      }
    }

    const clientDataHash = sha256(clientDataBuffer);
    const signedData = Buffer.concat([authDataBuffer, clientDataHash]);
    const rawSignature = fromBase64Url(payload.response.signature);

    const { publicKeyPem } = normalizePublicKeyToPem(
      storedCredential.publicKey,
      storedCredential.algorithm
    );
    const keyObject = crypto.createPublicKey(publicKeyPem);

    let verified = false;
    if (storedCredential.algorithm === -8 || keyObject.asymmetricKeyType === "ed25519") {
      verified = crypto.verify(null, signedData, keyObject, rawSignature);
    } else if (storedCredential.algorithm === -257 || keyObject.asymmetricKeyType === "rsa") {
      verified = crypto.verify("sha256", signedData, keyObject, rawSignature);
    } else {
      // Default ES256 (-7)
      const derSig = ensureDerEcdsaSignature(rawSignature);
      verified = crypto.verify("sha256", signedData, keyObject, derSig);
    }

    if (!verified) {
      throw new AuthUnauthorizedError("Invalid passkey cryptographic signature");
    }

    await (this.prisma as any).webAuthnCredential.update({
      where: { id: storedCredential.id },
      data: {
        counter: header.signCount,
        lastUsedAt: new Date(),
      },
    });

    if (meta) {
      await this.loginSecurity.handleSuccessfulLogin({
        userId: user.id,
        email: user.email,
        username: user.username,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      role: (user.role as UserRole) ?? UserRole.USER,
    });

    return {
      user: toSafeUserWithPasskeys(user, true),
      token,
    };
  }

  /**
   * Lists all registered passkeys for an authenticated user.
   */
  public async listPasskeys(userId: string): Promise<PasskeySummary[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AuthNotFoundError("User not found");
    }

    const credentials = await (this.prisma as any).webAuthnCredential.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return credentials.map(toPasskeySummary);
  }

  /**
   * Revokes a registered passkey by its ID (or credentialId), ensuring the user
   * still retains at least one valid sign-in method.
   */
  public async revokePasskey(
    userId: string,
    passkeyId: string
  ): Promise<{ deletedId: string; user: SafeUser }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AuthNotFoundError("User not found");
    }

    const allPasskeys = await (this.prisma as any).webAuthnCredential.findMany({
      where: { userId },
    });

    const target = allPasskeys.find(
      (p: { id: string; credentialId: string }) =>
        p.id === passkeyId || p.credentialId === passkeyId
    );
    if (!target) {
      throw new AuthNotFoundError("Passkey not found");
    }

    const remainingPasskeyCount = allPasskeys.length - 1;
    const hasPassword = Boolean((user as any).passwordHash ?? (user as any).password);
    if (!hasPassword && !user.googleId && remainingPasskeyCount === 0) {
      throw new AuthConflictError(
        "Cannot remove your only sign-in method. Set a password, link Google, or register another passkey first."
      );
    }

    await (this.prisma as any).webAuthnCredential.delete({
      where: { id: target.id },
    });

    return {
      deletedId: target.id,
      user: toSafeUserWithPasskeys(user, remainingPasskeyCount > 0),
    };
  }
}

export const webauthnService = new WebAuthnService();
export default webauthnService;
