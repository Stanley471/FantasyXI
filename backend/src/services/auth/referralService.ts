import crypto from "crypto";
import { prisma } from "../../config/db.js";

export interface ReferralCodeInfo {
  referralCode: string;
  referralLink: string;
}

export interface AffiliateStats {
  referralCode: string;
  referralLink: string;
  totalReferrals: number;
  activeReferrals: number;
  totalEarnedUsdc: number;
  referrees: Array<{
    id: string;
    username: string;
    joinedAt: Date;
  }>;
}

export class ReferralService {
  /**
   * Generates or retrieves a unique referral code and shareable referral link for a user.
   */
  static async getOrCreateReferralCode(userId: string): Promise<ReferralCodeInfo> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });

    let code = user?.referralCode;

    if (!code) {
      const randomSuffix = crypto.randomBytes(3).toString("hex").toUpperCase();
      code = `REF-${randomSuffix}`;

      await prisma.user.update({
        where: { id: userId },
        data: { referralCode: code },
      });
    }

    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    return {
      referralCode: code,
      referralLink: `${baseUrl}/register?ref=${code}`,
    };
  }

  /**
   * Attributes a newly registered user to a referrer via referral code.
   */
  static async applyReferralCode(newUserId: string, referralCode: string): Promise<boolean> {
    if (!referralCode || referralCode.trim() === "") return false;

    const referrer = await prisma.user.findUnique({
      where: { referralCode: referralCode.trim() },
      select: { id: true },
    });

    if (!referrer || referrer.id === newUserId) {
      return false; // Cannot refer oneself or invalid code
    }

    await prisma.user.update({
      where: { id: newUserId },
      data: { referrerId: referrer.id },
    });

    return true;
  }

  /**
   * Fetches affiliate dashboard statistics and total USDC earned via referrals.
   */
  static async getAffiliateDashboard(userId: string): Promise<AffiliateStats> {
    const linkInfo = await this.getOrCreateReferralCode(userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        referrees: {
          select: {
            id: true,
            username: true,
            createdAt: true,
            memberships: {
              where: { hasPaid: true },
              select: { id: true, league: { select: { entryFee: true } } },
            },
          },
        },
      },
    });

    const referrees = user?.referrees || [];
    const totalReferrals = referrees.length;

    let totalPaidEntries = 0;
    let totalEarnedUsdc = 0;

    referrees.forEach((ref) => {
      if (ref.memberships.length > 0) {
        totalPaidEntries += ref.memberships.length;
        ref.memberships.forEach((m) => {
          const fee = typeof m.league.entryFee === "number"
            ? m.league.entryFee
            : parseFloat(m.league.entryFee.toString()) || 0;
          // Affiliate cut: 20% of 5% platform fee = 1% of total entry fee
          totalEarnedUsdc += fee * 0.01;
        });
      }
    });

    return {
      referralCode: linkInfo.referralCode,
      referralLink: linkInfo.referralLink,
      totalReferrals,
      activeReferrals: referrees.filter((r) => r.memberships.length > 0).length,
      totalEarnedUsdc: parseFloat(totalEarnedUsdc.toFixed(2)),
      referrees: referrees.map((r) => ({
        id: r.id,
        username: r.username,
        joinedAt: r.createdAt,
      })),
    };
  }
}
