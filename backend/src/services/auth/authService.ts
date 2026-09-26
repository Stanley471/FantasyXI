import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma as defaultPrisma } from "../../config/db.js";
import { signAccessToken } from "../../config/jwt.js";
import {
  RegisterInput,
  LoginInput,
  SafeUser,
  AuthResult,
  UserRole,
} from "../../types/index.js";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = defaultPrisma) {}

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
  public async register(input: RegisterInput): Promise<AuthResult> {
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

    const safeUser = toSafeUser(user);
    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      role: user.role ?? UserRole.USER,
    });

    return {
      user: safeUser,
      token,
    };
  }

  /**
   * Authenticates user with email and password.
   * Returns generic 401 message on any credential mismatch to prevent enumeration.
   */
  public async login(input: LoginInput): Promise<AuthResult> {
    if (!input.email || !input.password) {
      throw new AuthUnauthorizedError("Invalid email or password");
    }

    const normalizedEmail = this.normalizeEmail(input.email);

    const user = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Timing-safe / generic rejection if user does not exist or has no password set (e.g. Google-only user)
    if (!user || !user.passwordHash) {
      throw new AuthUnauthorizedError("Invalid email or password");
    }

    // Compare with bcrypt
    const isPasswordValid = await bcrypt.compare(
      input.password,
      user.passwordHash
    );

    if (!isPasswordValid) {
      throw new AuthUnauthorizedError("Invalid email or password");
    }

    const safeUser = toSafeUser(user);
    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      role: user.role ?? UserRole.USER,
    });

    return {
      user: safeUser,
      token,
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
      const safeUser = toSafeUser(user);
      const token = signAccessToken({
        userId: user.id,
        email: user.email,
        username: user.username,
        role: user.role ?? UserRole.USER,
      });
      return { user: safeUser, token };
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

    const safeUser = toSafeUser(user);
    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      role: user.role ?? UserRole.USER,
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
