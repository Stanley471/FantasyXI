/**
 * WebAuthn / Passkey Service (issue #273).
 *
 * FIDO2 passkeys (Face ID, Touch ID, Windows Hello, security keys) as a
 * passwordless sign-in and as the step-up second factor after a password,
 * following W3C WebAuthn Level 3 via @simplewebauthn/server:
 *  - Registration (§7.1) requires a discoverable credential and user
 *    verification, so a passkey alone is multi-factor and supports
 *    usernameless sign-in (no account enumeration through allowCredentials).
 *  - Replay protection: every ceremony challenge is 32 random bytes, single
 *    use and short-lived. It is claimed atomically (Redis DEL, or Map.delete
 *    when Redis is down) before verification, so a captured response can
 *    never be accepted twice. The authenticator signs the challenge, origin
 *    and RP ID hash; tampering with any of them fails signature verification.
 *  - Signature counter (§6.1.1): an assertion whose counter does not advance
 *    is rejected and logged as a possible cloned authenticator. The stored
 *    counter is advanced with compare-and-set, so two assertions racing on the
 *    same credential cannot both succeed.
 *
 * Each ceremony costs O(1) Redis operations and O(1) indexed queries
 * (credential lookup by primary key); options list at most
 * MAX_CREDENTIALS_PER_USER credentials.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  decodeClientDataJSON,
  isoBase64URL,
  isoUint8Array,
  parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";
import { prisma as defaultPrisma } from "../../config/db.js";
import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import {
  securityAnomalyLog as defaultAnomalyLog,
  SecurityAnomalyLog,
  SecurityAnomalyType,
} from "../security/securityAnomalyLog.js";

/** A passkey ceremony failed; carries the HTTP status the controller answers with. */
export class PasskeyError extends Error {
  constructor(message: string, public readonly statusCode: 400 | 401 | 404 | 409) {
    super(message);
    this.name = "PasskeyError";
  }
}

export type PasskeyCeremony = "registration" | "authentication" | "step-up";

export interface WebAuthnConfig {
  rpID: string;
  rpName: string;
  /** Every origin the frontend is served from (scheme + host + port) */
  origins: string[];
}

/** WEBAUTHN_RP_ID / WEBAUTHN_RP_NAME / WEBAUTHN_ORIGINS, defaulting to FRONTEND_URL. */
export function loadWebAuthnConfig(env: NodeJS.ProcessEnv = process.env): WebAuthnConfig {
  const origins = (env.WEBAUTHN_ORIGINS || env.FRONTEND_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    rpID: env.WEBAUTHN_RP_ID || new URL(origins[0]).hostname,
    rpName: env.WEBAUTHN_RP_NAME || "FantasyXI",
    origins,
  };
}

export interface PasskeySummary {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface VerifiedPasskeyAssertion {
  userId: string;
  ceremony: Exclude<PasskeyCeremony, "registration">;
}

interface PendingCeremony {
  ceremony: PasskeyCeremony;
  /** Account the ceremony is bound to; null for usernameless sign-in */
  userId: string | null;
}

const CEREMONY_PREFIX = "webauthn:ceremony:";
const CEREMONY_TTL_SECONDS = 5 * 60;
const MAX_CREDENTIALS_PER_USER = 10;
const MAX_NAME_LENGTH = 64;
const MEMORY_SWEEP_THRESHOLD = 1_000;
const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set<AuthenticatorTransportFuture>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

const PASSKEY_SELECT = {
  id: true,
  name: true,
  deviceType: true,
  backedUp: true,
  transports: true,
  createdAt: true,
  lastUsedAt: true,
} as const;

/** Transports are client-reported (§5.2.1): keep only values the spec defines. */
function toTransports(values: unknown): AuthenticatorTransportFuture[] {
  return Array.isArray(values)
    ? (values.filter((value) => typeof value === "string" && KNOWN_TRANSPORTS.has(value)) as AuthenticatorTransportFuture[])
    : [];
}

/** WebAuthn user handle: the account UUID as bytes (opaque, no personal data, < 64 bytes). */
function userHandleFor(userId: string): string {
  return isoBase64URL.fromUTF8String(userId);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasStrings(value: unknown, keys: string[]): boolean {
  return isObject(value) && keys.every((key) => typeof value[key] === "string");
}

function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  return hasStrings(value, ["id", "rawId"]) && hasStrings((value as RegistrationResponseJSON).response, ["clientDataJSON", "attestationObject"]);
}

function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  return (
    hasStrings(value, ["id", "rawId"]) &&
    hasStrings((value as AuthenticationResponseJSON).response, ["clientDataJSON", "authenticatorData", "signature"])
  );
}

/**
 * Single-use ceremony state. Redis when it answers, otherwise a per-process
 * map; a ceremony lives in exactly one of them, so claiming it is atomic.
 */
class CeremonyStore {
  private readonly memory = new Map<string, { pending: PendingCeremony; expiresAt: number }>();

  constructor(private readonly redis: IRedisCacheClient | null) {}

  public async put(challenge: string, pending: PendingCeremony): Promise<void> {
    const key = `${CEREMONY_PREFIX}${challenge}`;
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(pending), "EX", CEREMONY_TTL_SECONDS);
        return;
      } catch (err) {
        console.warn(`[webauthn] Redis SET error, falling back to memory:`, (err as Error).message);
      }
    }
    if (this.memory.size >= MEMORY_SWEEP_THRESHOLD) {
      const now = Date.now();
      for (const [entryKey, entry] of this.memory) {
        if (entry.expiresAt <= now) this.memory.delete(entryKey);
      }
    }
    this.memory.set(key, { pending, expiresAt: Date.now() + CEREMONY_TTL_SECONDS * 1000 });
  }

  /** Returns the ceremony and removes it; only one caller can ever claim a challenge. */
  public async take(challenge: string): Promise<PendingCeremony | null> {
    const key = `${CEREMONY_PREFIX}${challenge}`;
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        // DEL is atomic: of two concurrent claims only one removes the key
        if (raw && (await this.redis.del(key)) === 1) {
          return JSON.parse(raw) as PendingCeremony;
        }
      } catch (err) {
        console.warn(`[webauthn] Redis claim error, falling back to memory:`, (err as Error).message);
      }
    }
    const entry = this.memory.get(key);
    if (!entry || !this.memory.delete(key) || entry.expiresAt <= Date.now()) return null;
    return entry.pending;
  }
}

export interface WebAuthnServiceOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  redis?: IRedisCacheClient | null;
  config?: WebAuthnConfig;
  anomalyLog?: SecurityAnomalyLog;
}

export class WebAuthnService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly ceremonies: CeremonyStore;
  private readonly fixedConfig?: WebAuthnConfig;
  private readonly anomalyLog: SecurityAnomalyLog;

  constructor(options: WebAuthnServiceOptions = {}) {
    this.db = options.db ?? defaultPrisma;
    this.ceremonies = new CeremonyStore(options.redis !== undefined ? options.redis : getRedisClient());
    this.fixedConfig = options.config;
    this.anomalyLog = options.anomalyLog ?? defaultAnomalyLog;
  }

  private get config(): WebAuthnConfig {
    return this.fixedConfig ?? loadWebAuthnConfig();
  }

  /** Begins registering a new passkey for a signed-in account. */
  public async generateRegistrationOptions(user: {
    id: string;
    email: string;
    username: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing: Array<{ id: string; transports: string[] }> = await this.db.webAuthnCredential.findMany({
      where: { userId: user.id },
      select: { id: true, transports: true },
    });
    if (existing.length >= MAX_CREDENTIALS_PER_USER) {
      throw new PasskeyError(`You can register at most ${MAX_CREDENTIALS_PER_USER} passkeys. Remove one first.`, 409);
    }

    const { rpID, rpName } = this.config;
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.email,
      userID: isoUint8Array.fromUTF8String(user.id),
      userDisplayName: user.username,
      attestationType: "none",
      // The authenticator refuses to create a second passkey for this account
      excludeCredentials: existing.map((credential) => ({
        id: credential.id,
        transports: toTransports(credential.transports),
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await this.ceremonies.put(options.challenge, { ceremony: "registration", userId: user.id });
    return options;
  }

  /** Verifies the attestation (§7.1) and stores the new credential. */
  public async verifyRegistration(userId: string, response: unknown, name?: unknown): Promise<PasskeySummary> {
    if (!isRegistrationResponse(response)) {
      throw new PasskeyError("A passkey registration response is required", 400);
    }
    if (name !== undefined && (typeof name !== "string" || name.trim().length > MAX_NAME_LENGTH)) {
      throw new PasskeyError(`Passkey name must be a string of at most ${MAX_NAME_LENGTH} characters`, 400);
    }
    const { challenge } = await this.claimPending(response.response.clientDataJSON, ["registration"], userId);

    const { rpID, origins } = this.config;
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new PasskeyError(`Passkey registration could not be verified: ${(err as Error).message}`, 400);
    }
    if (!verification.verified) {
      throw new PasskeyError("Passkey registration could not be verified", 400);
    }

    const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;
    const count: number = await this.db.webAuthnCredential.count({ where: { userId } });
    if (count >= MAX_CREDENTIALS_PER_USER) {
      throw new PasskeyError(`You can register at most ${MAX_CREDENTIALS_PER_USER} passkeys. Remove one first.`, 409);
    }

    try {
      return await this.db.webAuthnCredential.create({
        data: {
          id: credential.id,
          userId,
          publicKey: credential.publicKey,
          counter: BigInt(credential.counter),
          transports: toTransports(credential.transports),
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          aaguid,
          name:
            (typeof name === "string" && name.trim()) ||
            (credentialDeviceType === "multiDevice" ? "Synced passkey" : "Security key"),
        },
        select: PASSKEY_SELECT,
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "P2002") {
        throw new PasskeyError("This passkey is already registered", 409);
      }
      throw error;
    }
  }

  /** Begins a usernameless passkey sign-in (discoverable credentials, §5.4.6). */
  public async generateAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({ rpID: this.config.rpID, userVerification: "required" });
    await this.ceremonies.put(options.challenge, { ceremony: "authentication", userId: null });
    return options;
  }

  /** Second factor after a verified password: only this account's passkeys are accepted. */
  public async generateStepUpOptions(
    userId: string,
    credentials: Array<{ id: string; transports: string[] }>
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; expiresAt: Date }> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: toTransports(credential.transports),
      })),
    });
    await this.ceremonies.put(options.challenge, { ceremony: "step-up", userId });
    return { options, expiresAt: new Date(Date.now() + CEREMONY_TTL_SECONDS * 1000) };
  }

  /** Verifies an assertion (§7.2) for either sign-in ceremony. */
  public async verifyAuthentication(response: unknown, context: { ip: string }): Promise<VerifiedPasskeyAssertion> {
    if (!isAuthenticationResponse(response)) {
      throw new PasskeyError("A passkey authentication response is required", 400);
    }
    const pending = await this.claimPending(response.response.clientDataJSON, ["authentication", "step-up"]);

    const stored = await this.db.webAuthnCredential.findUnique({ where: { id: response.id } });
    if (!stored || (pending.userId !== null && stored.userId !== pending.userId)) {
      throw new PasskeyError("This passkey is not registered for this account", 401);
    }
    // §7.2 step 6: the user handle, when returned, must name the credential's owner;
    // a usernameless ceremony identifies the user only through it, so it is required
    const userHandle = response.response.userHandle;
    if ((pending.userId === null && !userHandle) || (userHandle && userHandle !== userHandleFor(stored.userId))) {
      throw new PasskeyError("Passkey does not belong to this account", 401);
    }

    const { rpID, origins } = this.config;
    const storedCounter = Number(stored.counter);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        credential: {
          id: stored.id,
          publicKey: new Uint8Array(stored.publicKey),
          counter: storedCounter,
          transports: toTransports(stored.transports),
        },
        requireUserVerification: true,
      });
    } catch (err) {
      this.flagCounterRegression(response, stored, storedCounter, context.ip);
      throw new PasskeyError(`Passkey sign-in could not be verified: ${(err as Error).message}`, 401);
    }
    if (!verification.verified) {
      throw new PasskeyError("Passkey sign-in could not be verified", 401);
    }

    // Compare-and-set: a concurrent assertion that already moved the counter wins
    const updated = await this.db.webAuthnCredential.updateMany({
      where: { id: stored.id, counter: stored.counter },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        backedUp: verification.authenticationInfo.credentialBackedUp,
        lastUsedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new PasskeyError("Passkey sign-in could not be verified: concurrent use detected", 401);
    }

    return { userId: stored.userId, ceremony: pending.ceremony as VerifiedPasskeyAssertion["ceremony"] };
  }

  public listCredentials(userId: string): Promise<PasskeySummary[]> {
    return this.db.webAuthnCredential.findMany({
      where: { userId },
      select: PASSKEY_SELECT,
      orderBy: { createdAt: "asc" },
    });
  }

  public async deleteCredential(userId: string, credentialId: string): Promise<void> {
    const { count } = await this.db.webAuthnCredential.deleteMany({ where: { id: credentialId, userId } });
    if (count === 0) {
      throw new PasskeyError("Passkey not found", 404);
    }
  }

  /** Claims a ceremony and checks it is of an expected kind and bound to `userId`. */
  private async claimPending(
    clientDataJSON: string,
    expected: PasskeyCeremony[],
    userId?: string
  ): Promise<PendingCeremony & { challenge: string }> {
    let challenge: string;
    try {
      challenge = decodeClientDataJSON(clientDataJSON).challenge;
    } catch {
      throw new PasskeyError("Malformed passkey response", 400);
    }
    const pending = typeof challenge === "string" ? await this.ceremonies.take(challenge) : null;
    if (!pending || !expected.includes(pending.ceremony) || (userId !== undefined && pending.userId !== userId)) {
      throw new PasskeyError("This passkey request has expired or was already used. Please try again.", 401);
    }
    return { ...pending, challenge };
  }

  /** §6.1.1: a counter that did not advance may mean the authenticator was cloned. */
  private flagCounterRegression(
    response: AuthenticationResponseJSON,
    stored: { id: string; userId: string },
    storedCounter: number,
    ip: string
  ): void {
    try {
      const { counter } = parseAuthenticatorData(isoBase64URL.toBuffer(response.response.authenticatorData));
      if ((counter > 0 || storedCounter > 0) && counter <= storedCounter) {
        this.anomalyLog.record({
          type: SecurityAnomalyType.WEBAUTHN_COUNTER_REGRESSION,
          userId: stored.userId,
          identifier: stored.id,
          ip,
          detail: { storedCounter, assertedCounter: counter },
        });
      }
    } catch {
      // Unparseable authenticator data was already rejected by verification
    }
  }
}

export const webAuthnService = new WebAuthnService();
