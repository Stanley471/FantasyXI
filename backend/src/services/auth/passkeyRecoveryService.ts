import { randomBytes, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { prisma as defaultPrisma } from "../../config/db.js";
import { emailService as defaultEmailService, type EmailService } from "../email/emailService.js";
import {
  securityAnomalyLog as defaultAnomalyLog,
  SecurityAnomalyLog,
  SecurityAnomalyType,
} from "../security/securityAnomalyLog.js";
import { refreshTokenService as defaultRefreshTokens, type RefreshTokenService } from "./refreshTokenService.js";
import {
  sessionRegistryService as defaultSessions,
  type SessionRegistryService,
} from "./sessionRegistryService.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

function decodeBase64Url(value: unknown, expectedLength: number): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === expectedLength ? new Uint8Array(decoded) : null;
  } catch {
    return null;
  }
}

function safeUser(user: Record<string, unknown>) {
  const {
    passwordHash: _passwordHash,
    passkeyRecoveryKey: _passkeyRecoveryKey,
    ...safe
  } = user;
  return safe;
}

export class PasskeyRecoveryError extends Error {
  constructor(message: string, public readonly statusCode: 400 | 401 | 409) {
    super(message);
    this.name = "PasskeyRecoveryError";
  }
}

export interface PasskeyRecoveryOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  sessions?: SessionRegistryService;
  refreshTokens?: RefreshTokenService;
  email?: EmailService;
  anomalyLog?: SecurityAnomalyLog;
  now?: () => Date;
}

export class PasskeyRecoveryService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly sessions: SessionRegistryService;
  private readonly refreshTokens: RefreshTokenService;
  private readonly email: EmailService;
  private readonly anomalyLog: SecurityAnomalyLog;
  private readonly now: () => Date;

  constructor(options: PasskeyRecoveryOptions = {}) {
    this.db = options.db ?? defaultPrisma;
    this.sessions = options.sessions ?? defaultSessions;
    this.refreshTokens = options.refreshTokens ?? defaultRefreshTokens;
    this.email = options.email ?? defaultEmailService;
    this.anomalyLog = options.anomalyLog ?? defaultAnomalyLog;
    this.now = options.now ?? (() => new Date());
  }

  public async configure(userId: string, encodedPublicKey: unknown): Promise<{ configuredAt: Date }> {
    const publicKey = decodeBase64Url(encodedPublicKey, PUBLIC_KEY_BYTES);
    if (!publicKey) throw new PasskeyRecoveryError("A valid recovery public key is required", 400);
    const passkeyCount = await this.db.webAuthnCredential.count({ where: { userId } });
    if (passkeyCount === 0) {
      throw new PasskeyRecoveryError("Register a passkey before creating a recovery key", 409);
    }
    const configuredAt = this.now();
    await this.db.$transaction(async (tx: any) => {
      await tx.passkeyRecoveryKey.upsert({
        where: { userId },
        create: { userId, publicKey: Buffer.from(publicKey), createdAt: configuredAt },
        update: { publicKey: Buffer.from(publicKey), createdAt: configuredAt, usedAt: null },
      });
      await tx.passkeyRecoveryChallenge.deleteMany({ where: { userId } });
      await tx.accountSecurityEvent.create({
        data: { userId, type: "PASSKEY_RECOVERY_CONFIGURED", detail: { algorithm: "Ed25519" } },
      });
    });
    return { configuredAt };
  }

  /** Always returns the same shape to avoid disclosing whether an email has recovery configured. */
  public async begin(emailInput: unknown): Promise<{ challengeId: string; challenge: string; expiresAt: string }> {
    const email = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";
    const challengeId = randomUUID();
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + CHALLENGE_TTL_MS);
    const user = email
      ? await this.db.user.findUnique({
          where: { email },
          select: { id: true, passkeyRecoveryKey: { select: { usedAt: true } } },
        })
      : null;
    if (user?.passkeyRecoveryKey && !user.passkeyRecoveryKey.usedAt) {
      await this.db.passkeyRecoveryChallenge.create({
        data: { id: challengeId, userId: user.id, challenge, expiresAt },
      });
    }
    return { challengeId, challenge, expiresAt: expiresAt.toISOString() };
  }

  public async complete(
    input: { challengeId?: unknown; challenge?: unknown; signature?: unknown },
    context: { ip: string; userAgent?: string | null }
  ) {
    const challengeId = typeof input.challengeId === "string" ? input.challengeId : "";
    const challenge = typeof input.challenge === "string" ? input.challenge : "";
    const signature = decodeBase64Url(input.signature, SIGNATURE_BYTES);
    const pending = challengeId
      ? await this.db.passkeyRecoveryChallenge.findUnique({
          where: { id: challengeId },
          include: { user: { include: { passkeyRecoveryKey: true } } },
        })
      : null;
    const publicKey = pending?.user?.passkeyRecoveryKey?.publicKey;
    const valid =
      pending &&
      signature &&
      publicKey &&
      pending.challenge === challenge &&
      !pending.usedAt &&
      !pending.user.passkeyRecoveryKey.usedAt &&
      pending.expiresAt > this.now() &&
      ed25519.verify(signature, Buffer.from(challenge, "base64url"), new Uint8Array(publicKey));
    if (!valid) throw new PasskeyRecoveryError("Recovery proof is invalid or expired", 401);

    const completedAt = this.now();
    const consume = async (tx: any) => {
      const claimed = await tx.passkeyRecoveryChallenge.updateMany({
        where: { id: challengeId, usedAt: null, expiresAt: { gt: completedAt } },
        data: { usedAt: completedAt },
      });
      if (claimed.count !== 1) return false;
      await tx.webAuthnCredential.deleteMany({ where: { userId: pending.userId } });
      await tx.refreshToken.updateMany({
        where: { userId: pending.userId, revokedAt: null },
        data: { revokedAt: completedAt },
      });
      await tx.passkeyRecoveryKey.update({ where: { userId: pending.userId }, data: { usedAt: completedAt } });
      await tx.accountSecurityEvent.create({
        data: {
          userId: pending.userId,
          type: "PASSKEY_RECOVERY_COMPLETED",
          detail: { ip: context.ip, invalidatedPasskeys: true, invalidatedSessions: true },
        },
      });
      return true;
    };
    const consumed = await this.db.$transaction(consume);
    if (!consumed) throw new PasskeyRecoveryError("Recovery proof is invalid or expired", 401);

    await this.sessions.revokeAllUserSessions(pending.userId, undefined, "Passkey account recovery");
    const session = await this.sessions.createSession(pending.userId, context);
    const issued = await this.refreshTokens.issue(pending.user, undefined, session.id);
    this.anomalyLog.record({
      type: SecurityAnomalyType.PASSKEY_RECOVERY_COMPLETED,
      userId: pending.userId,
      identifier: challengeId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    this.email
      .getProvider()
      .sendEmail({
        to: pending.user.email,
        subject: "Your FantasyXI passkeys were recovered",
        text: "Your recovery key was used. Existing passkeys and sessions were revoked. Sign in and register new passkeys now. If this was not you, contact support immediately.",
        html: "<p>Your recovery key was used.</p><p>Existing passkeys and sessions were revoked. Sign in and register new passkeys now.</p><p>If this was not you, contact support immediately.</p>",
      })
      .catch((error) => console.error("[passkey-recovery] Failed to send security email", error));

    return { user: safeUser(pending.user), ...issued, requiresPasskeyRegistration: true };
  }
}

export const passkeyRecoveryService = new PasskeyRecoveryService();
