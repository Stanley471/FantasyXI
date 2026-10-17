import crypto from "crypto";
import {
  AuthValidationError,
  AuthUnauthorizedError,
  AuthConflictError,
  AuthNotFoundError,
} from "./authService.js";

export type AuthenticatorTransport = "usb" | "nfc" | "ble" | "internal" | "hybrid";

export interface StoredPasskeyCredential {
  credentialId: string;
  userId: string;
  publicKeyPem: string;
  algorithm: "Ed25519" | "ES256";
  counter: number;
  transports: AuthenticatorTransport[];
  deviceName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  compromised: boolean;
}

export interface ChallengeRecord {
  challenge: string;
  userId?: string;
  type: "registration" | "authentication";
  intent: "login" | "step_up_2fa" | "register";
  origin: string;
  rpId: string;
  expiresAt: number;
  used: boolean;
}

export interface RegistrationOptions {
  challenge: string;
  rp: {
    name: string;
    id: string;
  };
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout: number;
  attestation: "none" | "direct" | "indirect";
  excludeCredentials: Array<{
    id: string;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
  authenticatorSelection: {
    residentKey: "preferred" | "required" | "discouraged";
    userVerification: "preferred" | "required" | "discouraged";
  };
}

export interface AuthenticationOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: "preferred" | "required" | "discouraged";
  allowCredentials: Array<{
    id: string;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
  intent: "login" | "step_up_2fa";
}

export interface RegistrationResponsePayload {
  id: string;
  rawId?: string;
  type: "public-key";
  deviceName?: string;
  response: {
    clientDataJSON: string; // base64url encoded JSON
    authenticatorData: string; // base64url encoded binary buffer
    publicKeyPem: string; // PEM encoded Ed25519 or P-256 public key
    algorithm?: "Ed25519" | "ES256";
    transports?: AuthenticatorTransport[];
  };
}

export interface AuthenticationResponsePayload {
  id: string;
  rawId?: string;
  type: "public-key";
  response: {
    clientDataJSON: string; // base64url
    authenticatorData: string; // base64url
    signature: string; // base64url
    userHandle?: string;
  };
}

export interface WebAuthnVerificationResult {
  verified: boolean;
  userId: string;
  credentialId: string;
  newCounter: number;
  intent: "login" | "step_up_2fa";
  stepUpToken?: string;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const USER_PRESENT_FLAG = 0x01; // Bit 0 of flags byte
const USER_VERIFIED_FLAG = 0x04; // Bit 2 of flags byte

export function toBase64Url(buffer: Buffer): string {
  return buffer
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

/**
 * Parses a raw WebAuthn authenticatorData buffer (minimum 37 bytes):
 * - bytes 0..31: SHA-256 hash of rpId (32 bytes)
 * - byte 32: flags (bit 0 = UP, bit 2 = UV, bit 6 = AT, bit 7 = ED)
 * - bytes 33..36: signCount (uint32 big-endian)
 */
export function parseAuthenticatorData(authDataBuffer: Buffer): {
  rpIdHash: Buffer;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  counter: number;
} {
  if (authDataBuffer.length < 37) {
    throw new AuthValidationError("Invalid authenticatorData: must be at least 37 bytes");
  }
  const rpIdHash = authDataBuffer.subarray(0, 32);
  const flags = authDataBuffer.readUInt8(32);
  const counter = authDataBuffer.readUInt32BE(33);

  return {
    rpIdHash,
    flags,
    userPresent: (flags & USER_PRESENT_FLAG) !== 0,
    userVerified: (flags & USER_VERIFIED_FLAG) !== 0,
    counter,
  };
}

/**
 * Helper to build binary authenticatorData for tests and attestation/assertion verification.
 */
export function buildAuthenticatorData(options: {
  rpId: string;
  counter: number;
  userPresent?: boolean;
  userVerified?: boolean;
}): Buffer {
  const rpIdHash = crypto.createHash("sha256").update(options.rpId, "utf8").digest();
  let flags = 0;
  if (options.userPresent !== false) flags |= USER_PRESENT_FLAG;
  if (options.userVerified) flags |= USER_VERIFIED_FLAG;

  const flagsAndCounter = Buffer.alloc(5);
  flagsAndCounter.writeUInt8(flags, 0);
  flagsAndCounter.writeUInt32BE(options.counter >>> 0, 1);

  return Buffer.concat([rpIdHash, flagsAndCounter]);
}

export class WebAuthnService {
  private readonly rpName: string;
  private readonly rpId: string;
  private readonly expectedOrigin: string;
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly credentialsById = new Map<string, StoredPasskeyCredential>();
  private readonly credentialsByUser = new Map<string, Set<string>>();

  constructor(config?: { rpName?: string; rpId?: string; expectedOrigin?: string }) {
    this.rpName = config?.rpName ?? process.env.WEBAUTHN_RP_NAME ?? "FantasyXI";
    this.rpId = config?.rpId ?? process.env.WEBAUTHN_RP_ID ?? "localhost";
    this.expectedOrigin =
      config?.expectedOrigin ?? process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000";
  }

  /**
   * Generates a registration challenge and WebAuthn creation options for a user.
   */
  generateRegistrationOptions(params: {
    userId: string;
    email: string;
    displayName?: string;
    nowMs?: number;
  }): RegistrationOptions {
    if (!params.userId || !params.email) {
      throw new AuthValidationError("userId and email are required to generate registration options");
    }

    const nowMs = params.nowMs ?? Date.now();
    this.pruneExpiredChallenges(nowMs);

    const challenge = toBase64Url(crypto.randomBytes(32));
    this.challenges.set(challenge, {
      challenge,
      userId: params.userId,
      type: "registration",
      intent: "register",
      origin: this.expectedOrigin,
      rpId: this.rpId,
      expiresAt: nowMs + CHALLENGE_TTL_MS,
      used: false,
    });

    const existingCreds = this.listUserCredentials(params.userId);

    return {
      challenge,
      rp: {
        name: this.rpName,
        id: this.rpId,
      },
      user: {
        id: toBase64Url(Buffer.from(params.userId, "utf8")),
        name: params.email,
        displayName: params.displayName ?? params.email,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -8 }, // EdDSA (Ed25519)
        { type: "public-key", alg: -7 }, // ES256 (ECDSA P-256)
      ],
      timeout: 60000,
      attestation: "none",
      excludeCredentials: existingCreds.map((cred) => ({
        id: cred.credentialId,
        type: "public-key" as const,
        transports: cred.transports,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    };
  }

  /**
   * Verifies a WebAuthn registration response and stores the user's hardware passkey credential.
   */
  verifyRegistrationResponse(params: {
    userId: string;
    response: RegistrationResponsePayload;
    nowMs?: number;
  }): StoredPasskeyCredential {
    const nowMs = params.nowMs ?? Date.now();
    const { userId, response } = params;

    if (!response || response.type !== "public-key" || !response.id || !response.response) {
      throw new AuthValidationError("Invalid WebAuthn registration payload");
    }

    if (this.credentialsById.has(response.id)) {
      throw new AuthConflictError("Credential ID is already registered");
    }

    // 1. Decode and verify clientDataJSON
    let clientData: { type?: string; challenge?: string; origin?: string };
    try {
      const decoded = fromBase64Url(response.response.clientDataJSON).toString("utf8");
      clientData = JSON.parse(decoded);
    } catch {
      throw new AuthValidationError("Malformed clientDataJSON in registration response");
    }

    if (clientData.type !== "webauthn.create") {
      throw new AuthValidationError(`Unexpected clientData type: ${clientData.type}`);
    }

    if (!clientData.challenge) {
      throw new AuthValidationError("Missing challenge in clientDataJSON");
    }

    const challengeRecord = this.consumeChallenge(
      clientData.challenge,
      "registration",
      nowMs,
      userId
    );

    if (clientData.origin !== challengeRecord.origin) {
      throw new AuthUnauthorizedError(
        `Origin mismatch: expected ${challengeRecord.origin}, got ${clientData.origin}`
      );
    }

    // 2. Parse and verify authenticatorData
    const authDataBuffer = fromBase64Url(response.response.authenticatorData);
    const parsedAuthData = parseAuthenticatorData(authDataBuffer);

    const expectedRpIdHash = crypto
      .createHash("sha256")
      .update(challengeRecord.rpId, "utf8")
      .digest();

    if (!parsedAuthData.rpIdHash.equals(expectedRpIdHash)) {
      throw new AuthUnauthorizedError("RP ID hash mismatch in authenticatorData");
    }

    if (!parsedAuthData.userPresent) {
      throw new AuthUnauthorizedError("User Present (UP) flag was not set by authenticator");
    }

    // 3. Validate publicKeyPem format
    const publicKeyPem = response.response.publicKeyPem;
    if (!publicKeyPem || typeof publicKeyPem !== "string") {
      throw new AuthValidationError("Public key PEM is required for credential registration");
    }

    let keyObj: crypto.KeyObject;
    try {
      keyObj = crypto.createPublicKey(publicKeyPem);
    } catch {
      throw new AuthValidationError("Invalid public key PEM provided");
    }

    const detectedAlg: "Ed25519" | "ES256" =
      keyObj.asymmetricKeyType === "ed25519" ? "Ed25519" : "ES256";

    const credential: StoredPasskeyCredential = {
      credentialId: response.id,
      userId,
      publicKeyPem,
      algorithm: response.response.algorithm ?? detectedAlg,
      counter: parsedAuthData.counter,
      transports: response.response.transports ?? ["internal"],
      deviceName: response.deviceName ?? "Passkey Authenticator",
      createdAt: new Date(nowMs),
      lastUsedAt: null,
      compromised: false,
    };

    this.credentialsById.set(credential.credentialId, credential);
    let userSet = this.credentialsByUser.get(userId);
    if (!userSet) {
      userSet = new Set();
      this.credentialsByUser.set(userId, userSet);
    }
    userSet.add(credential.credentialId);

    return credential;
  }

  /**
   * Generates an authentication challenge for either standalone passwordless login
   * or step-up 2FA (e.g. for high-value treasury withdrawals).
   */
  generateAuthenticationOptions(params?: {
    userId?: string;
    intent?: "login" | "step_up_2fa";
    nowMs?: number;
  }): AuthenticationOptions {
    const nowMs = params?.nowMs ?? Date.now();
    this.pruneExpiredChallenges(nowMs);

    const intent = params?.intent ?? "login";
    const challenge = toBase64Url(crypto.randomBytes(32));

    let allowCredentials: AuthenticationOptions["allowCredentials"] = [];
    if (params?.userId) {
      const creds = this.listUserCredentials(params.userId).filter((c) => !c.compromised);
      if (creds.length === 0) {
        throw new AuthNotFoundError("No active passkey credentials registered for this user");
      }
      allowCredentials = creds.map((c) => ({
        id: c.credentialId,
        type: "public-key" as const,
        transports: c.transports,
      }));
    }

    this.challenges.set(challenge, {
      challenge,
      userId: params?.userId,
      type: "authentication",
      intent,
      origin: this.expectedOrigin,
      rpId: this.rpId,
      expiresAt: nowMs + CHALLENGE_TTL_MS,
      used: false,
    });

    return {
      challenge,
      rpId: this.rpId,
      timeout: 60000,
      userVerification: intent === "step_up_2fa" ? "required" : "preferred",
      allowCredentials,
      intent,
    };
  }

  /**
   * Verifies a WebAuthn assertion signature, prevents challenge replay, and enforces
   * strict signature counter progression to detect cloned hardware authenticators.
   */
  verifyAuthenticationResponse(params: {
    response: AuthenticationResponsePayload;
    expectedUserId?: string;
    nowMs?: number;
  }): WebAuthnVerificationResult {
    const nowMs = params.nowMs ?? Date.now();
    const { response, expectedUserId } = params;

    if (!response || response.type !== "public-key" || !response.id || !response.response) {
      throw new AuthValidationError("Invalid WebAuthn authentication payload");
    }

    const credential = this.credentialsById.get(response.id);
    if (!credential) {
      throw new AuthUnauthorizedError("Unknown passkey credential");
    }

    if (credential.compromised) {
      throw new AuthUnauthorizedError(
        "Passkey credential has been flagged as compromised due to counter regression"
      );
    }

    if (expectedUserId && credential.userId !== expectedUserId) {
      throw new AuthUnauthorizedError("Credential does not belong to the expected user");
    }

    // 1. Decode and validate clientDataJSON
    const clientDataRawBuffer = fromBase64Url(response.response.clientDataJSON);
    let clientData: { type?: string; challenge?: string; origin?: string };
    try {
      clientData = JSON.parse(clientDataRawBuffer.toString("utf8"));
    } catch {
      throw new AuthValidationError("Malformed clientDataJSON in assertion response");
    }

    if (clientData.type !== "webauthn.get") {
      throw new AuthValidationError(`Unexpected clientData type: ${clientData.type}`);
    }

    if (!clientData.challenge) {
      throw new AuthValidationError("Missing challenge in clientDataJSON");
    }

    const challengeRecord = this.consumeChallenge(
      clientData.challenge,
      "authentication",
      nowMs,
      expectedUserId ?? credential.userId
    );

    if (clientData.origin !== challengeRecord.origin) {
      throw new AuthUnauthorizedError(
        `Origin mismatch: expected ${challengeRecord.origin}, got ${clientData.origin}`
      );
    }

    // 2. Parse and verify authenticatorData
    const authDataBuffer = fromBase64Url(response.response.authenticatorData);
    const parsedAuthData = parseAuthenticatorData(authDataBuffer);

    const expectedRpIdHash = crypto
      .createHash("sha256")
      .update(challengeRecord.rpId, "utf8")
      .digest();

    if (!parsedAuthData.rpIdHash.equals(expectedRpIdHash)) {
      throw new AuthUnauthorizedError("RP ID hash mismatch in authenticatorData");
    }

    if (!parsedAuthData.userPresent) {
      throw new AuthUnauthorizedError("User Present (UP) flag was not set by authenticator");
    }

    if (challengeRecord.intent === "step_up_2fa" && !parsedAuthData.userVerified) {
      throw new AuthUnauthorizedError(
        "User Verification (UV) flag is required for step-up 2FA assertions"
      );
    }

    // 3. Verify cryptographic signature over authenticatorData || SHA256(clientDataJSON)
    const clientDataHash = crypto.createHash("sha256").update(clientDataRawBuffer).digest();
    const signedPayload = Buffer.concat([authDataBuffer, clientDataHash]);
    const signatureBuffer = fromBase64Url(response.response.signature);

    const publicKey = crypto.createPublicKey(credential.publicKeyPem);
    const isSignatureValid =
      credential.algorithm === "Ed25519"
        ? crypto.verify(null, signedPayload, publicKey, signatureBuffer)
        : crypto.verify("sha256", signedPayload, publicKey, signatureBuffer);

    if (!isSignatureValid) {
      throw new AuthUnauthorizedError("Invalid WebAuthn assertion signature");
    }

    // 4. Verify signature counter regression (cloning protection)
    if (credential.counter > 0 || parsedAuthData.counter > 0) {
      if (parsedAuthData.counter <= credential.counter) {
        credential.compromised = true;
        throw new AuthUnauthorizedError(
          `Authenticator counter regression detected (stored=${credential.counter}, received=${parsedAuthData.counter}). Credential marked compromised.`
        );
      }
    }

    credential.counter = parsedAuthData.counter;
    credential.lastUsedAt = new Date(nowMs);

    const result: WebAuthnVerificationResult = {
      verified: true,
      userId: credential.userId,
      credentialId: credential.credentialId,
      newCounter: credential.counter,
      intent: challengeRecord.intent === "step_up_2fa" ? "step_up_2fa" : "login",
    };

    if (result.intent === "step_up_2fa") {
      result.stepUpToken = toBase64Url(
        crypto
          .createHmac("sha256", process.env.JWT_SECRET ?? "webauthn-stepup-secret")
          .update(`${credential.userId}:${credential.credentialId}:${nowMs}`)
          .digest()
      );
    }

    return result;
  }

  /**
   * Lists all registered passkey credentials for a user.
   */
  listUserCredentials(userId: string): StoredPasskeyCredential[] {
    const ids = this.credentialsByUser.get(userId);
    if (!ids) return [];
    const list: StoredPasskeyCredential[] = [];
    for (const id of ids) {
      const cred = this.credentialsById.get(id);
      if (cred) list.push(cred);
    }
    return list;
  }

  private consumeChallenge(
    challenge: string,
    expectedType: "registration" | "authentication",
    nowMs: number,
    userId?: string
  ): ChallengeRecord {
    const record = this.challenges.get(challenge);
    if (!record) {
      throw new AuthUnauthorizedError("Invalid or unknown WebAuthn challenge");
    }

    if (record.used) {
      this.challenges.delete(challenge);
      throw new AuthUnauthorizedError("WebAuthn challenge has already been used (replay rejected)");
    }

    if (nowMs > record.expiresAt) {
      this.challenges.delete(challenge);
      throw new AuthUnauthorizedError("WebAuthn challenge has expired");
    }

    if (record.type !== expectedType) {
      throw new AuthUnauthorizedError(
        `Challenge type mismatch: expected ${expectedType}, got ${record.type}`
      );
    }

    if (record.userId && userId && record.userId !== userId) {
      throw new AuthUnauthorizedError("Challenge was issued for a different user");
    }

    record.used = true;
    this.challenges.delete(challenge);
    return record;
  }

  private pruneExpiredChallenges(nowMs: number): void {
    for (const [key, record] of this.challenges.entries()) {
      if (record.used || nowMs > record.expiresAt) {
        this.challenges.delete(key);
      }
    }
  }
}

export const webauthnService = new WebAuthnService();
