import bcrypt from "bcryptjs";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { prisma as defaultPrisma } from "../../config/db.js";
import { signAccessToken, verifyPurposeToken } from "../../config/jwt.js";
import { PASSKEY_MFA_PURPOSE, WebAuthnConfig, loadWebAuthnConfig } from "../../config/webauthn.js";
import { AuthResult, UserRole } from "../../types/index.js";
import { toSafeUser, type AuthRequestContext } from "./authService.js";
import {
  loginSecurityService as defaultLoginSecurityService,
  LoginSecurityService,
} from "../security/loginSecurityService.js";

/** Malformed request (400). */
export class WebAuthnValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthnValidationError";
  }
}

/** Ceremony rejected: unknown, replayed, expired, tampered or cloned credential (401). */
export class WebAuthnVerificationError extends Error {
  constructor(message = "Passkey verification failed") {
    super(message);
    this.name = "WebAuthnVerificationError";
  }
}

/** State conflict, e.g. a credential that is already registered (409). */
export class WebAuthnConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthnConflictError";
  }
}

export class WebAuthnNotFoundError extends Error {
  constructor(message = "Passkey not found") {
    super(message);
    this.name = "WebAuthnNotFoundError";
  }
}

type ChallengeType = "REGISTRATION" | "AUTHENTICATION" | "MFA";

export interface PasskeySummary {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

const MAX_PASSKEYS_PER_USER = 10;
const MAX_NAME_LENGTH = 64;

function toSummary(credential: any): PasskeySummary {
  return {
    id: credential.id,
    name: credential.name ?? null,
    deviceType: credential.deviceType,
    backedUp: Boolean(credential.backedUp),
    transports: credential.transports ?? [],
    createdAt: credential.createdAt,
    lastUsedAt: credential.lastUsedAt ?? null,
  };
}

/** Reads the challenge the client signed from a ceremony response, without trusting anything else in it. */
function extractChallenge(response: unknown): string {
  const clientDataJSON = (response as { response?: { clientDataJSON?: unknown } })?.response?.clientDataJSON;
  if (typeof clientDataJSON !== "string" || clientDataJSON.length === 0 || clientDataJSON.length > 4096) {
    throw new WebAuthnValidationError("Invalid WebAuthn response");
  }
  try {
    const clientData = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
    if (typeof clientData?.challenge !== "string" || clientData.challenge.length === 0) {
      throw new Error("missing challenge");
    }
    return clientData.challenge;
  } catch {
    throw new WebAuthnValidationError("Invalid WebAuthn response");
  }
}

function credentialIdOf(response: unknown): string {
  const id = (response as { id?: unknown })?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(id)) {
    throw new WebAuthnValidationError("Invalid WebAuthn response");
  }
  return id;
}

/**
 * WebAuthn / passkey provider (issue #273), built on @simplewebauthn/server.
 *
 * Ceremonies:
 * - registration: a signed-in user adds one or more passkeys / security keys;
 * - passwordless login: discoverable passkey (or one tied to an email) -> session;
 * - step-up MFA: after a correct password, accounts with passkey MFA enabled
 *   must also present a passkey before a session is issued.
 *
 * Replay protection: every challenge is random, single-use and short-lived. It
 * is consumed with an atomic conditional update *before* the response is
 * verified, so a captured response can never be accepted twice. Signatures are
 * verified against the stored public key, and the signature counter must move
 * forward (a regression signals a cloned authenticator); the counter update is
 * conditional on the previous value, so two concurrent assertions cannot both win.
 */
export class WebAuthnService {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = defaultPrisma,
    private readonly config: WebAuthnConfig = loadWebAuthnConfig(),
    private readonly security: LoginSecurityService = defaultLoginSecurityService
  ) {}

  // ============================================================
  // Challenges
  // ============================================================

  private async storeChallenge(challenge: string, type: ChallengeType, userId: string | null): Promise<void> {
    const now = Date.now();
    await this.db.webAuthnChallenge.create({
      data: { challenge, type, userId, expiresAt: new Date(now + this.config.challengeTtlMs) },
    });
    // Best-effort housekeeping of abandoned ceremonies
    this.db.webAuthnChallenge
      .deleteMany({ where: { expiresAt: { lt: new Date(now - 60 * 60 * 1000) } } })
      .catch(() => undefined);
  }

  /** Atomically marks the challenge used. Throws if unknown, expired, of another type or already used. */
  private async consumeChallenge(challenge: string, type: ChallengeType) {
    const now = new Date();
    const consumed = await this.db.webAuthnChallenge.updateMany({
      where: { challenge, type, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new WebAuthnVerificationError("The passkey challenge is invalid, expired or already used");
    }
    return this.db.webAuthnChallenge.findUnique({ where: { challenge } });
  }

  private issueSession(user: any): AuthResult {
    return {
      user: toSafeUser(user),
      token: signAccessToken({
        userId: user.id,
        email: user.email,
        username: user.username,
        role: user.role ?? UserRole.USER,
      }),
    };
  }

  // ============================================================
  // Registration
  // ============================================================

  public async startRegistration(userId: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new WebAuthnNotFoundError("User not found");

    const existing = await this.db.passkeyCredential.findMany({ where: { userId } });
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new WebAuthnConflictError(`An account can register at most ${MAX_PASSKEYS_PER_USER} passkeys`);
    }

    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpID,
      userName: user.email,
      userDisplayName: user.name ?? user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      // Lets the authenticator refuse to create a second credential for the same account
      excludeCredentials: existing.map((c: any) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      timeout: this.config.challengeTtlMs,
    });
    await this.storeChallenge(options.challenge, "REGISTRATION", userId);
    return options;
  }

  public async finishRegistration(userId: string, response: RegistrationResponseJSON, name?: unknown): Promise<PasskeySummary> {
    const label = typeof name === "string" ? name.trim().slice(0, MAX_NAME_LENGTH) || null : null;
    const stored = await this.consumeChallenge(extractChallenge(response), "REGISTRATION");
    if (!stored || stored.userId !== userId) {
      throw new WebAuthnVerificationError("The passkey challenge was issued to another account");
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: this.config.origins,
        expectedRPID: this.config.rpID,
        requireUserVerification: false,
      });
    } catch {
      throw new WebAuthnVerificationError("Passkey registration could not be verified");
    }
    if (!verification.verified) {
      throw new WebAuthnVerificationError("Passkey registration could not be verified");
    }

    const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;
    try {
      const created = await this.db.passkeyCredential.create({
        data: {
          userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: BigInt(credential.counter),
          transports: credential.transports ?? response.response?.transports ?? [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          aaguid,
          name: label,
        },
      });
      return toSummary(created);
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") {
        throw new WebAuthnConflictError("This passkey is already registered");
      }
      throw error;
    }
  }

  // ============================================================
  // Assertions (passwordless login and step-up MFA)
  // ============================================================

  private async allowCredentialsFor(userId: string) {
    const credentials = await this.db.passkeyCredential.findMany({ where: { userId } });
    return credentials.map((c: any) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] }));
  }

  /**
   * Verifies an assertion against a consumed challenge and advances the
   * stored counter. Returns the credential's owner.
   */
  private async verifyAssertion(
    response: AuthenticationResponseJSON,
    type: ChallengeType,
    options: { requiredUserId?: string; requireUserVerification: boolean }
  ) {
    const credentialId = credentialIdOf(response);
    const stored = await this.consumeChallenge(extractChallenge(response), type);
    if (!stored) throw new WebAuthnVerificationError();
    if (options.requiredUserId && stored.userId !== options.requiredUserId) {
      throw new WebAuthnVerificationError("The passkey challenge was issued to another account");
    }

    const credential = await this.db.passkeyCredential.findUnique({ where: { credentialId } });
    if (!credential) throw new WebAuthnVerificationError();
    // A challenge issued for a specific account only accepts that account's passkeys
    const expectedUser = options.requiredUserId ?? stored.userId ?? null;
    if (expectedUser && credential.userId !== expectedUser) {
      throw new WebAuthnVerificationError();
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: this.config.origins,
        expectedRPID: this.config.rpID,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: Number(credential.counter),
          transports: credential.transports,
        },
        requireUserVerification: options.requireUserVerification,
      });
    } catch {
      // Bad signature, wrong origin/RP, tampered data or a counter that did not advance
      throw new WebAuthnVerificationError();
    }
    if (!verification.verified) throw new WebAuthnVerificationError();

    const advanced = await this.db.passkeyCredential.updateMany({
      where: { id: credential.id, counter: credential.counter },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    if (advanced.count !== 1) {
      // Another assertion with this credential won the race
      throw new WebAuthnVerificationError();
    }

    const user = await this.db.user.findUnique({ where: { id: credential.userId } });
    if (!user) throw new WebAuthnVerificationError();
    return user;
  }

  /**
   * Options for a passwordless login. Without an email the browser offers any
   * discoverable passkey for this site. With an email, that account's passkeys
   * are listed; an unknown email gets the same response shape as a known one,
   * so the endpoint does not reveal which accounts exist.
   */
  public async startAuthentication(email?: unknown): Promise<PublicKeyCredentialRequestOptionsJSON> {
    let userId: string | null = null;
    let allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }> = [];
    if (typeof email === "string" && email.trim()) {
      const user = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      if (user) {
        allowCredentials = await this.allowCredentialsFor(user.id);
        if (allowCredentials.length > 0) userId = user.id;
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      allowCredentials,
      userVerification: "required",
      timeout: this.config.challengeTtlMs,
    });
    await this.storeChallenge(options.challenge, "AUTHENTICATION", userId);
    return options;
  }

  /** Passwordless login: the passkey is the only factor, so user verification is required. */
  public async finishAuthentication(
    response: AuthenticationResponseJSON,
    context?: AuthRequestContext
  ): Promise<AuthResult> {
    const user = await this.verifyAssertion(response, "AUTHENTICATION", { requireUserVerification: true });
    if (context) {
      await this.security.handleSuccessfulLogin({
        userId: user.id,
        email: user.email,
        username: user.username,
        ip: context.ip,
        userAgent: context.userAgent,
      });
    }
    return this.issueSession(user);
  }

  private userFromMfaToken(mfaToken: unknown): string {
    const userId = verifyPurposeToken(mfaToken, PASSKEY_MFA_PURPOSE);
    if (!userId) throw new WebAuthnVerificationError("The sign-in session expired. Please sign in again.");
    return userId;
  }

  /** Options for the passkey step-up after a correct password. */
  public async startMfa(mfaToken: unknown): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const userId = this.userFromMfaToken(mfaToken);
    const allowCredentials = await this.allowCredentialsFor(userId);
    if (allowCredentials.length === 0) {
      throw new WebAuthnVerificationError("No passkey is registered for this account");
    }
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      allowCredentials,
      userVerification: "preferred",
      timeout: this.config.challengeTtlMs,
    });
    await this.storeChallenge(options.challenge, "MFA", userId);
    return options;
  }

  /** Completes a password login: the passkey proves possession, so presence is enough. */
  public async finishMfa(mfaToken: unknown, response: AuthenticationResponseJSON): Promise<AuthResult> {
    const userId = this.userFromMfaToken(mfaToken);
    const user = await this.verifyAssertion(response, "MFA", {
      requiredUserId: userId,
      requireUserVerification: false,
    });
    return this.issueSession(user);
  }

  // ============================================================
  // Management
  // ============================================================

  public async listPasskeys(userId: string): Promise<PasskeySummary[]> {
    const credentials = await this.db.passkeyCredential.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return credentials.map(toSummary);
  }

  public async deletePasskey(userId: string, passkeyId: string): Promise<void> {
    const credential = await this.db.passkeyCredential.findFirst({ where: { id: passkeyId, userId } });
    if (!credential) throw new WebAuthnNotFoundError();

    const user = await this.db.user.findUnique({ where: { id: userId } });
    const remaining = await this.db.passkeyCredential.count({ where: { userId } });
    if (user?.passkeyMfaEnabled && remaining <= 1) {
      throw new WebAuthnConflictError("Turn off passkey two-step sign-in before removing your last passkey");
    }
    await this.db.passkeyCredential.delete({ where: { id: credential.id } });
  }

  /**
   * Turns passkey step-up for password logins on or off. Needs at least one
   * passkey to enable, and the current password either way, so a stolen
   * session token alone cannot weaken the account.
   */
  public async setMfaEnabled(userId: string, enabled: unknown, currentPassword: unknown): Promise<{ passkeyMfaEnabled: boolean }> {
    if (typeof enabled !== "boolean") throw new WebAuthnValidationError("enabled must be a boolean");
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new WebAuthnNotFoundError("User not found");
    if (!user.passwordHash) {
      throw new WebAuthnConflictError("Passkey two-step sign-in protects password sign-in; set a password first");
    }
    const passwordOk =
      typeof currentPassword === "string" && (await bcrypt.compare(currentPassword, user.passwordHash));
    if (!passwordOk) throw new WebAuthnVerificationError("Current password is incorrect");

    if (enabled && (await this.db.passkeyCredential.count({ where: { userId } })) === 0) {
      throw new WebAuthnConflictError("Register a passkey before turning on two-step sign-in");
    }
    await this.db.user.update({ where: { id: userId }, data: { passkeyMfaEnabled: enabled } });
    return { passkeyMfaEnabled: enabled };
  }
}

export const webauthnService = new WebAuthnService();
