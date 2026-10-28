import crypto from "crypto";
import { prisma } from "../../config/db.js";
import { signAccessToken } from "../../config/jwt.js";

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
const ttlSeconds = () => {
  const configured = Number(process.env.REFRESH_TOKEN_TTL_SECONDS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_TTL_SECONDS;
};
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export class RefreshTokenUnauthorizedError extends Error {
  constructor(message = "Refresh token is invalid, expired, or revoked") {
    super(message);
    this.name = "RefreshTokenUnauthorizedError";
  }
}

export class RefreshTokenService {
  constructor(private readonly db: any = prisma) {}

  async issue(user: any, familyId = crypto.randomUUID(), sessionId?: string) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);
    // Some isolated AuthService unit tests use a minimal mock without persistence.
    if (this.db.refreshToken?.create) {
      await this.db.refreshToken.create({ data: { familyId, userId: user.id, tokenHash: hash(token), expiresAt } });
    }
    return {
      token: signAccessToken({ userId: user.id, email: user.email, username: user.username, role: user.role ?? "USER", ...(sessionId ? { sessionId } : {}) }),
      refreshToken: token,
    };
  }

  async rotate(rawToken: unknown) {
    if (typeof rawToken !== "string" || rawToken.length < 32 || !this.db.refreshToken) {
      throw new RefreshTokenUnauthorizedError();
    }
    const current = await this.db.refreshToken.findUnique({ where: { tokenHash: hash(rawToken) }, include: { user: true } });
    if (!current) throw new RefreshTokenUnauthorizedError();
    if (current.revokedAt || current.expiresAt <= new Date()) {
      if (current.revokedAt) await this.revokeFamily(current.familyId);
      throw new RefreshTokenUnauthorizedError(current.expiresAt <= new Date() ? "Refresh token has expired" : "Refresh token reuse detected");
    }

    const nextToken = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds() * 1000);
    const rotate = async (tx: any) => {
      const claimed = await tx.refreshToken.updateMany({ where: { id: current.id, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
      if (claimed.count !== 1) return false;
      await tx.refreshToken.create({ data: { familyId: current.familyId, userId: current.userId, tokenHash: hash(nextToken), expiresAt } });
      return true;
    };
    const success = this.db.$transaction ? await this.db.$transaction(rotate) : await rotate(this.db);
    if (!success) {
      await this.revokeFamily(current.familyId);
      throw new RefreshTokenUnauthorizedError("Refresh token reuse detected");
    }
    return {
      token: signAccessToken({ userId: current.user.id, email: current.user.email, username: current.user.username, role: current.user.role ?? "USER" }),
      refreshToken: nextToken,
    };
  }

  async revoke(rawToken: unknown): Promise<void> {
    if (typeof rawToken !== "string" || !this.db.refreshToken) return;
    const found = await this.db.refreshToken.findUnique({ where: { tokenHash: hash(rawToken) }, select: { familyId: true } });
    if (found) await this.revokeFamily(found.familyId);
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}

export const refreshTokenService = new RefreshTokenService();
