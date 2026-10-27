import { sessionRegistryService } from "./sessionRegistryService.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma as defaultPrisma } from "../../config/db.js";
import { signAccessToken } from "../../config/jwt.js";
import { RefreshTokenService } from "./refreshTokenService.js";
import {
  RegisterInput,
  LoginInput,
  LoginChallengeInput,
  LoginResult,
  PasskeyLoginChallenge,
  SafeUser,
  AuthResult,
  UserRole,
} from "../../types/index.js";
import { eventBus, EventBus } from "../events/eventBus.js";
import { USER_SIGNED_UP_EVENT } from "../events/domainEvents.js";
// Imported for its side effect: subscribes the signup analytics handler to
// USER_SIGNED_UP_EVENT (issue #118).
import "../events/userEventHandlers.js";
import {
  loginSecurityService as defaultLoginSecurityService,
  LoginSecurityService,
} from "../security/loginSecurityService.js";
import type { GeoPoint } from "../security/geoVelocity.js";
import {
  accountSignalRecorder as defaultSignalRecorder,
  AccountSignalRecorder,
} from "../security/accountSignals.js";
import { webAuthnService as defaultWebAuthnService, WebAuthnService } from "./webAuthnService.js";

/** Request-derived context used for anomalous-login detection (issues #117, #331). */
export interface AuthRequestContext {
  ip: string;
  userAgent?: string | null;
  /** IP-derived location from trusted edge headers, when configured */
  location?: GeoPoint | null;
}

/** Passkeys loaded with the user on login; only what step-up options need. */
const PASSKEY_STEP_UP_SELECT = { select: { id: true, transports: true } } as const;

/**
 * Custom error classes for Authentication domain rules.
 *
 * Laravel equivalent: FormRequest validation exceptions and AuthenticationException.
 */

export class AuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthValidationError";
  }
}

export class AuthConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConflictError";
  }
}

export class AuthUnauthorizedError extends Error {
  constructor(message: string = "Invalid email or password") {
    super(message);
    this.name = "AuthUnauthorizedError";
  }
}

/** A correct password was refused because the login looks like account takeover (issue #331). */
export class AuthLoginBlockedError extends Error {
  constructor(
    message: string = "This sign-in was blocked because it came from an implausibly distant location. Check your email for details."
  ) {
    super(message);
    this.name = "AuthLoginBlockedError";
  }
}

export class AuthNotFoundError extends Error {
  constructor(message: string = "User not found") {
    super(message);
    this.name = "AuthNotFoundError";
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

export function toSafeUser(user: {
  id: string;
  email: string;
  username: string;
  name?: string | null;
  role?: UserRole | string | null;
  passwordHash?: string | null;
  googleId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name ?? null,
    role: (user.role as UserRole | undefined) ?? UserRole.USER,
    // Which sign-in methods the account can use; never exposes the secrets themselves
    authProviders: {
      password: Boolean(user.passwordHash),
      google: Boolean(user.googleId),
    },
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** Prisma unique-constraint violation (e.g. a concurrent insert of the same googleId). */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

/** Verified Google identity passed to the account linking operations. */
export interface GoogleIdentityInput {
  googleId: string;
  email: string;
  name?: string | null;
  emailVerified: boolean;
}

/**
 * Authentication Service.
 *
 * Handles user registration, bcrypt password hashing, login verification,
 * JWT generation, and profile retrieval.
 *
 * Laravel equivalent: Laravel Fortify / Breeze authentication actions:
 *   RegistersUsers, AuthenticatesUsers, Hash::make, Hash::check.
 */
export class AuthService {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = defaultPrisma,
    private readonly events: EventBus = eventBus,
    private readonly security: LoginSecurityService = defaultLoginSecurityService,
    private readonly passkeys: WebAuthnService = defaultWebAuthnService,
    private readonly signals: AccountSignalRecorder = defaultSignalRecorder
  ) {}

  /**
   * Normalizes an email address consistently.
   */
  public normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Validates registration inputs.
   */
  public validateRegisterInput(input: RegisterInput): {
    normalizedEmail: string;
    normalizedUsername?: string;
  } {
    if (!input.email || typeof input.email !== "string") {
      throw new AuthValidationError("Email is required");
    }

    const normalizedEmail = this.normalizeEmail(input.email);
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      throw new AuthValidationError("Invalid email address format");
    }

    if (!input.password || typeof input.password !== "string") {
      throw new AuthValidationError("Password is required");
    }

    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthValidationError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`
      );
    }

    let normalizedUsername: string | undefined;
    if (input.username) {
      normalizedUsername = input.username.trim().toLowerCase();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 30) {
        throw new AuthValidationError(
          "Username must be between 3 and 30 characters"
        );
      }
      if (!/^[a-z0-9_-]+$/.test(normalizedUsername)) {
        throw new AuthValidationError(
          "Username can only contain letters, numbers, underscores, and dashes"
        );
      }
    }

    return { normalizedEmail, normalizedUsername };
  }

  /**
   * Generates a candidate username from display name or email prefix.
   */
  private generateBaseUsername(email: string, name?: string): string {
    const raw = name ? name : email.split("@")[0];
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 20);
    return cleaned.length >= 3 ? cleaned : `user_${cleaned}`;
  }

  /**
   * Registers a new user account with bcrypt hashed password.
   */
  public async register(input: RegisterInput, context?: AuthRequestContext): Promise<AuthResult> {
    const { normalizedEmail, normalizedUsername } =
      this.validateRegisterInput(input);

    // Check duplicate email
    const existingEmail = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingEmail) {
      throw new AuthConflictError("An account with this email already exists");
    }

    // Determine final username
    let finalUsername = normalizedUsername;
    if (finalUsername) {
      const existingUser = await this.db.user.findUnique({
        where: { username: finalUsername },
      });
      if (existingUser) {
        throw new AuthConflictError("Username is already taken");
      }
    } else {
      const base = this.generateBaseUsername(normalizedEmail, input.name);
      finalUsername = base;
      const existingBase = await this.db.user.findUnique({
        where: { username: finalUsername },
      });
      if (existingBase) {
        finalUsername = `${base}_${crypto.randomBytes(2).toString("hex")}`;
      }
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS);

    // Persist user
    const user = await this.db.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        username: finalUsername,
        name: input.name ? input.name.trim() : null,
      },
    });

    if (input.referralCode) {
      try {
        const referrer = await this.db.user.findUnique({
          where: { referralCode: input.referralCode.trim() },
          select: { id: true },
        });
        if (referrer && referrer.id !== user.id) {
          await this.db.user.update({
            where: { id: user.id },
            data: { referrerId: referrer.id },
          });
        }
      } catch (err) {
        console.warn("[AuthService] Failed to attribute referral code:", err);
      }
    }

    const session = await sessionRegistryService.createSession(user.id, {
      ip: "127.0.0.1",
      userAgent: null,
    });
    const safeUser = toSafeUser(user);
    const issued = await new RefreshTokenService(this.db).issue(user, undefined, session.id);

    // Best-effort: a signup analytics/notification subscriber failing must
    // never fail registration itself, so this uses `publish` (which never
    // throws) rather than `publishOrThrow` - see events/eventBus.ts.
    await this.events.publish(USER_SIGNED_UP_EVENT, {
      userId: user.id,
      email: user.email,
      username: user.username,
    });

    return {
      user: safeUser,
      ...issued,
    };
  }

  /**
   * Authenticates user with email and password.
   * Returns generic 401 message on any credential mismatch to prevent enumeration.
   *
   * `context` (client IP / user agent / location) is optional so existing
   * callers and tests that don't have request metadata keep working
   * unchanged; when provided, it drives the login security checks (see
   * services/security/loginSecurityService.ts): failed attempts are tracked
   * per email for spike detection (#117), an impossible-travel login is
   * refused with AuthLoginBlockedError, and a login from an unrecognized
   * device returns a step-up challenge instead of a token (#331).
   *
   * An account with a registered passkey always answers a correct password
   * with a WEBAUTHN step-up challenge instead of a token (#273), with or
   * without `context`: the passkey is the account's second factor.
   */
  public async login(input: LoginInput): Promise<AuthResult>;
  public async login(input: LoginInput, context: AuthRequestContext | undefined): Promise<LoginResult>;
  public async login(input: LoginInput, context?: AuthRequestContext): Promise<LoginResult> {
    if (!input.email || !input.password) {
      throw new AuthUnauthorizedError("Invalid email or password");
    }

    const normalizedEmail = this.normalizeEmail(input.email);

    const user = await this.db.user.findUnique({
      where: { email: normalizedEmail },
      include: { webAuthnCredentials: PASSKEY_STEP_UP_SELECT },
    });

    // Timing-safe / generic rejection if user does not exist or has no password set (e.g. Google-only user)
    if (!user || !user.passwordHash) {
      if (context) {
        await this.security.recordFailedLogin(normalizedEmail, context.ip);
      }
      throw new AuthUnauthorizedError("Invalid email or password");
    }

    // Compare with bcrypt
    const isPasswordValid = await bcrypt.compare(
      input.password,
      user.passwordHash
    );

    if (!isPasswordValid) {
      if (context) {
        await this.security.recordFailedLogin(normalizedEmail, context.ip);
      }
      throw new AuthUnauthorizedError("Invalid email or password");
    }

    // A phishing-resistant, device-bound second factor supersedes the
    // new-device email code and the impossible-travel heuristic
    const passkeys: Array<{ id: string; transports: string[] }> = user.webAuthnCredentials ?? [];
    if (passkeys.length > 0) {
      const { options, expiresAt } = await this.passkeys.generateStepUpOptions(user.id, passkeys);
      const challenge: PasskeyLoginChallenge = {
        challengeRequired: true,
        method: "WEBAUTHN",
        options,
        expiresAt: expiresAt.toISOString(),
      };
      return challenge;
    }

    if (context) {
      const assessment = await this.security.assessLogin({
        userId: user.id,
        email: user.email,
        username: user.username,
        ip: context.ip,
        userAgent: context.userAgent,
        deviceFingerprint: typeof input.deviceFingerprint === "string" ? input.deviceFingerprint : null,
        location: context.location,
      });
      if (assessment.decision === "BLOCK") {
        throw new AuthLoginBlockedError();
      }
      if (assessment.decision === "CHALLENGE") {
        return {
          challengeRequired: true,
          challengeId: assessment.challengeId,
          method: "EMAIL_OTP",
          expiresAt: assessment.expiresAt.toISOString(),
        };
      }
      this.signals.record(user.id, { ...context, deviceFingerprint: input.deviceFingerprint });
    }

    const session = await sessionRegistryService.createSession(user.id, {
      ip: "127.0.0.1",
      userAgent: null,
    });
    return this.issueAuthResult(user, session.id);
  }

  /**
   * Completes a passkey sign-in (#273): usernameless passwordless login, or
   * the WEBAUTHN step-up that followed a verified password.
   */
  public async loginWithPasskey(
    response: unknown,
    context: AuthRequestContext & { deviceFingerprint?: string | null }
  ): Promise<AuthResult> {
    const { userId } = await this.passkeys.verifyAuthentication(response, context);
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AuthNotFoundError("User not found");
    }
    this.signals.record(user.id, context);
    return this.issueAuthResult(user);
  }

  /**
   * Completes a login that was answered with a step-up challenge: a valid
   * code issues the token and remembers the device for future logins.
   * `context` records the sign-in network for Sybil analysis (#274).
   */
  public async verifyLoginChallenge(input: LoginChallengeInput, context?: AuthRequestContext): Promise<AuthResult> {
    if (typeof input.challengeId !== "string" || typeof input.code !== "string" || !/^\d{6}$/.test(input.code)) {
      throw new AuthValidationError("A challengeId and a 6-digit code are required");
    }

    const verification = await this.security.verifyChallenge(input.challengeId, input.code);
    if (!verification.verified) {
      throw new AuthUnauthorizedError(
        verification.attemptsRemaining > 0
          ? `Incorrect verification code. ${verification.attemptsRemaining} attempt(s) remaining.`
          : "This verification code has expired or been used up. Please sign in again."
      );
    }

    const user = await this.db.user.findUnique({ where: { id: verification.userId } });
    if (!user) {
      throw new AuthNotFoundError("User not found");
    }
    if (context) {
      this.signals.record(user.id, { ip: context.ip });
    }
    return this.issueAuthResult(user);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async issueAuthResult(user: any, sessionId?: string): Promise<AuthResult> {
    const issued = await new RefreshTokenService(this.db).issue(user, undefined, sessionId);
    return {
      user: toSafeUser(user),
      ...issued,
    };
  }

  /**
   * Handles Google OAuth authentication and safe account linking.
   *
   * Rules:
   * 1. Requires verified email from Google (emailVerified === true).
   * 2. If googleId matches existing user -> authenticate user.
   * 3. If email matches existing user:
   *    - If user already linked to a different googleId -> throw AuthConflictError.
   *    - Safe account linking: links googleId to existing user WITHOUT touching passwordHash.
   * 4. If neither matches -> creates new user with passwordHash = null.
   * 5. Always issues FantasyXI JWT access token.
   */
  public async handleGoogleAuth(input: GoogleIdentityInput): Promise<AuthResult> {
    if (!input.googleId) {
      throw new AuthValidationError("Google ID is required");
    }

    if (!input.emailVerified) {
      throw new AuthValidationError("Google account email is not verified");
    }

    const normalizedEmail = this.normalizeEmail(input.email);

    // 1. Check if user already exists with this googleId
    let user = await this.db.user.findUnique({
      where: { googleId: input.googleId },
    });

    if (user) {
      return { user: toSafeUser(user), token: signAccessToken({ userId: user.id, email: user.email, username: user.username, role: user.role ?? UserRole.USER }) };
    }

    // 2. Check if a user with this email already exists
    const existingByEmail = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingByEmail) {
      // Conflict check: if this user is already linked to a different Google account
      if (
        existingByEmail.googleId &&
        existingByEmail.googleId !== input.googleId
      ) {
        throw new AuthConflictError(
          "This email address is already linked to a different Google account."
        );
      }

      // Safe account linking:
      // Link googleId to existing user, preserve existing passwordHash untouched
      user = await this.db.user.update({
        where: { id: existingByEmail.id },
        data: {
          googleId: input.googleId,
          name: existingByEmail.name ?? input.name ?? null,
        },
      });
    } else {
      // 3. Create a brand new user from Google
      const base = this.generateBaseUsername(
        normalizedEmail,
        input.name ?? undefined
      );
      let finalUsername = base;
      const existingUsername = await this.db.user.findUnique({
        where: { username: finalUsername },
      });
      if (existingUsername) {
        finalUsername = `${base}_${crypto.randomBytes(2).toString("hex")}`;
      }

      try {
        user = await this.db.user.create({
          data: {
            email: normalizedEmail,
            name: input.name ? input.name.trim() : null,
            googleId: input.googleId,
            username: finalUsername,
            passwordHash: null,
          },
        });
      } catch (error) {
        // A concurrent first sign-in with the same Google account won the race
        if (!isUniqueViolation(error)) throw error;
        user = await this.db.user.findUnique({
          where: { googleId: input.googleId },
        });
        if (!user) {
          throw new AuthConflictError(
            "An account with this email already exists. Sign in and link Google from your profile."
          );
        }
      }
    }

    const session = await sessionRegistryService.createSession(user.id, {
      ip: "127.0.0.1",
      userAgent: null,
    });
    const safeUser = toSafeUser(user);
    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      role: user.role ?? UserRole.USER,
      sessionId: session.id,
    });

    return {
      user: safeUser,
      token,
    };
  }

  /**
   * Links a Google identity to an already signed-in account.
   *
   * Unlike sign-in, the Google email does not have to match the account email:
   * the user proved ownership of both by being signed in and completing the
   * Google consent screen. Rules:
   * - the Google email must be verified;
   * - a Google account can belong to only one FantasyXI account;
   * - an account already linked to a different Google account must unlink first.
   * Linking the same Google account again is a no-op.
   */
  public async linkGoogleAccount(
    userId: string,
    identity: GoogleIdentityInput
  ): Promise<SafeUser> {
    if (!identity.googleId) {
      throw new AuthValidationError("Google ID is required");
    }
    if (!identity.emailVerified) {
      throw new AuthValidationError("Google account email is not verified");
    }

    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AuthNotFoundError("User not found");
    }

    if (user.googleId === identity.googleId) {
      return toSafeUser(user);
    }
    if (user.googleId) {
      throw new AuthConflictError(
        "Your account is already linked to a different Google account. Unlink it first."
      );
    }

    const owner = await this.db.user.findUnique({
      where: { googleId: identity.googleId },
    });
    if (owner && owner.id !== userId) {
      throw new AuthConflictError(
        "This Google account is already linked to another FantasyXI account."
      );
    }

    try {
      const updated = await this.db.user.update({
        where: { id: userId },
        data: {
          googleId: identity.googleId,
          name: user.name ?? identity.name ?? null,
        },
      });
      return toSafeUser(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthConflictError(
          "This Google account is already linked to another FantasyXI account."
        );
      }
      throw error;
    }
  }

  /**
   * Removes the Google identity from an account. Refused while Google is the
   * only way to sign in, so users cannot lock themselves out.
   */
  public async unlinkGoogleAccount(userId: string): Promise<SafeUser> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AuthNotFoundError("User not found");
    }
    if (!user.googleId) {
      return toSafeUser(user);
    }
    if (!user.passwordHash) {
      throw new AuthConflictError(
        "Set a password before unlinking Google, otherwise you will not be able to sign in."
      );
    }

    const updated = await this.db.user.update({
      where: { id: userId },
      data: { googleId: null },
    });
    return toSafeUser(updated);
  }

  /**
   * Sets a password so a Google-only account can also sign in with email and
   * password, or changes an existing password (the current one is required).
   */
  public async setPassword(
    userId: string,
    input: { password?: string; currentPassword?: string }
  ): Promise<SafeUser> {
    if (!input.password || typeof input.password !== "string") {
      throw new AuthValidationError("Password is required");
    }
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthValidationError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`
      );
    }

    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AuthNotFoundError("User not found");
    }

    if (user.passwordHash) {
      const currentMatches =
        typeof input.currentPassword === "string" &&
        (await bcrypt.compare(input.currentPassword, user.passwordHash));
      if (!currentMatches) {
        throw new AuthUnauthorizedError("Current password is incorrect");
      }
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS);
    const updated = await this.db.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    return toSafeUser(updated);
  }

  /**
   * Retrieves safe user profile by ID.
   */
  public async getMe(userId: string): Promise<SafeUser> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AuthNotFoundError("User not found");
    }

    return toSafeUser(user);
  }
}

export const authService = new AuthService();
