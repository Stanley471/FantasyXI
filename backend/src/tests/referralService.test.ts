import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReferralService } from "../services/auth/referralService.js";
import { AuthService } from "../services/auth/authService.js";
import { prisma } from "../config/db.js";

describe("Referral and Affiliate Reward System", () => {
  it("should generate a unique referral code format REF-XXXXXX", async () => {
    const originalFindUnique = prisma.user.findUnique;
    const originalUpdate = prisma.user.update;

    (prisma as any).user.findUnique = async () => ({ referralCode: null });
    let updatedData: any = null;
    (prisma as any).user.update = async (args: any) => {
      updatedData = args.data;
      return args;
    };

    try {
      const res = await ReferralService.getOrCreateReferralCode("user-123");
      assert.ok(res.referralCode.startsWith("REF-"));
      assert.ok(res.referralLink.includes(res.referralCode));
      assert.strictEqual(updatedData?.referralCode, res.referralCode);
    } finally {
      (prisma as any).user.findUnique = originalFindUnique;
      (prisma as any).user.update = originalUpdate;
    }
  });

  it("should attribute referrer when applying valid referral code", async () => {
    const originalFindUnique = prisma.user.findUnique;
    const originalUpdate = prisma.user.update;

    (prisma as any).user.findUnique = async ({ where }: any) => {
      if (where.referralCode === "REF-ABCDEF") {
        return { id: "referrer-999" };
      }
      return null;
    };

    let updateArgs: any = null;
    (prisma as any).user.update = async (args: any) => {
      updateArgs = args;
      return args;
    };

    try {
      const success = await ReferralService.applyReferralCode("newuser-100", "REF-ABCDEF");
      assert.strictEqual(success, true);
      assert.strictEqual(updateArgs.where.id, "newuser-100");
      assert.strictEqual(updateArgs.data.referrerId, "referrer-999");
    } finally {
      (prisma as any).user.findUnique = originalFindUnique;
      (prisma as any).user.update = originalUpdate;
    }
  });

  it("should calculate affiliate statistics and USDC earnings accurately", async () => {
    const originalFindUnique = prisma.user.findUnique;
    const originalUpdate = prisma.user.update;

    (prisma as any).user.findUnique = async ({ where }: any) => {
      if (where.id === "affiliate-1") {
        return {
          id: "affiliate-1",
          referralCode: "REF-111111",
          referrees: [
            {
              id: "ref-user-1",
              username: "UserOne",
              createdAt: new Date(),
              memberships: [
                { id: "m-1", hasPaid: true, league: { entryFee: 10.0 } },
                { id: "m-2", hasPaid: true, league: { entryFee: 20.0 } },
              ],
            },
          ],
        };
      }
      return { referralCode: "REF-111111" };
    };

    try {
      const stats = await ReferralService.getAffiliateDashboard("affiliate-1");
      assert.strictEqual(stats.totalReferrals, 1);
      assert.strictEqual(stats.activeReferrals, 1);
      // Entry fees = $30 total. 1% affiliate cut = $0.30
      assert.strictEqual(stats.totalEarnedUsdc, 0.3);
    } finally {
      (prisma as any).user.findUnique = originalFindUnique;
      (prisma as any).user.update = originalUpdate;
    }
  });
});
