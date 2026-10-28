import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requirePermission } from '@/middleware/auth';
import { logger } from '@/config/logger';

const router = Router();
const prisma = new PrismaClient();

/**
 * GET /api/v1/admin/leagues/:leagueId/collusion-flags
 * List all collusion flags for a league with pagination.
 * Requires: SECURITY_REVIEW permission
 */
router.get('/leagues/:leagueId/collusion-flags', requirePermission('SECURITY_REVIEW'), async (req: Request, res: Response) => {
  try {
    const { leagueId } = req.params;
    const { status, minRiskScore = 0, limit = 20, offset = 0 } = req.query;

    // Validate pagination
    const pageLimit = Math.min(Number(limit) || 20, 100);
    const pageOffset = Number(offset) || 0;

    // Build filter
    const where: any = { leagueId };
    if (status) {
      where.status = status;
    }
    if (minRiskScore) {
      where.riskScore = { gte: Number(minRiskScore) };
    }

    // Fetch flags
    const [flags, total] = await Promise.all([
      prisma.leagueCollusionFlag.findMany({
        where,
        include: {
          accountA: { select: { id: true, email: true, username: true } },
          accountB: { select: { id: true, email: true, username: true } },
        },
        orderBy: { riskScore: 'desc' },
        take: pageLimit,
        skip: pageOffset,
      }),
      prisma.leagueCollusionFlag.count({ where }),
    ]);

    // Sanitize evidence (remove raw IPs if present, though we use subnets)
    const sanitized = flags.map((flag) => ({
      ...flag,
      evidencePayload: sanitizeEvidence(flag.evidencePayload as any),
    }));

    res.json({
      data: sanitized,
      pagination: {
        limit: pageLimit,
        offset: pageOffset,
        total,
        hasMore: pageOffset + pageLimit < total,
      },
    });
  } catch (error) {
    logger.error('[Admin] Error listing flags:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/admin/collusion-flags/:flagId
 * Get detailed information about a specific flag.
 * Requires: SECURITY_REVIEW permission
 */
router.get('/collusion-flags/:flagId', requirePermission('SECURITY_REVIEW'), async (req: Request, res: Response) => {
  try {
    const { flagId } = req.params;

    const flag = await prisma.leagueCollusionFlag.findUnique({
      where: { id: flagId },
      include: {
        accountA: {
          select: { id: true, email: true, username: true, createdAt: true },
        },
        accountB: {
          select: { id: true, email: true, username: true, createdAt: true },
        },
        appeals: {
          select: {
            id: true,
            status: true,
            reason: true,
            appealedAt: true,
            reviewedAt: true,
            reviewNote: true,
          },
        },
      },
    });

    if (!flag) {
      return res.status(404).json({ error: 'Flag not found' });
    }

    res.json({
      ...flag,
      evidencePayload: sanitizeEvidence(flag.evidencePayload as any),
    });
  } catch (error) {
    logger.error('[Admin] Error fetching flag:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/admin/collusion-flags/:flagId/review
 * Admin reviews a flag: dismiss, confirm, or escalate.
 * Requires: ADMIN permission
 */
router.post(
  '/collusion-flags/:flagId/review',
  requirePermission('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { flagId } = req.params;
      const { status, reason, note } = req.body;
      const adminUserId = (req as any).user.id;

      // Validate status
      if (!['DISMISSED', 'CONFIRMED', 'ESCALATED'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      // Fetch flag
      const flag = await prisma.leagueCollusionFlag.findUnique({
        where: { id: flagId },
      });

      if (!flag) {
        return res.status(404).json({ error: 'Flag not found' });
      }

      // Update flag
      const updated = await prisma.leagueCollusionFlag.update({
        where: { id: flagId },
        data: {
          status,
          reviewedBy: adminUserId,
          reviewedAt: new Date(),
          reviewNote: note,
          dismissalReason: status === 'DISMISSED' ? reason : undefined,
        },
        include: {
          accountA: { select: { email: true, username: true } },
          accountB: { select: { email: true, username: true } },
        },
      });

      // Log to audit
      logger.info(`[Admin Review] Flag ${flagId} reviewed as ${status} by ${adminUserId}. Reason: ${reason}`);

      // Notify affected users if dismissed (to suppress future re-flags)
      if (status === 'DISMISSED') {
        // In production, send notifications to users
        logger.info(`[Notification] Would notify users of flag dismissal`);
      }

      res.json(updated);
    } catch (error) {
      logger.error('[Admin] Error reviewing flag:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/v1/admin/collusion-flags/:flagId/suspend
 * Suspend league participation for flagged accounts.
 * Requires: ADMIN permission
 */
router.post(
  '/collusion-flags/:flagId/suspend',
  requirePermission('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { flagId } = req.params;
      const { reason, leagueOnly = true } = req.body;
      const adminUserId = (req as any).user.id;

      if (!leagueOnly) {
        return res.status(400).json({ error: 'Platform-wide bans are not supported; only league suspension is allowed' });
      }

      // Fetch flag
      const flag = await prisma.leagueCollusionFlag.findUnique({
        where: { id: flagId },
        include: {
          league: true,
          accountA: true,
          accountB: true,
        },
      });

      if (!flag) {
        return res.status(404).json({ error: 'Flag not found' });
      }

      if (flag.suspendedLeagueParticipationAt) {
        return res.status(400).json({ error: 'Accounts already suspended' });
      }

      // Update flag to mark suspension
      const updated = await prisma.leagueCollusionFlag.update({
        where: { id: flagId },
        data: {
          suspendedLeagueParticipationAt: new Date(),
          suspensionReason: reason || 'Admin suspension due to collusion detection',
        },
      });

      // Log to audit
      logger.warn(
        `[Suspension] Accounts ${flag.accountAId} and ${flag.accountBId} suspended from league ${flag.leagueId} by admin ${adminUserId}. Reason: ${reason}`
      );

      // Notify users
      logger.info(`[Notification] Would notify accounts of suspension and appeal process`);

      res.json(updated);
    } catch (error) {
      logger.error('[Admin] Error suspending accounts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/v1/admin/collusion-flags/:flagId/unsuspend
 * Reverse league participation suspension.
 * Requires: ADMIN permission
 */
router.post(
  '/collusion-flags/:flagId/unsuspend',
  requirePermission('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { flagId } = req.params;
      const { reason } = req.body;
      const adminUserId = (req as any).user.id;

      // Fetch flag
      const flag = await prisma.leagueCollusionFlag.findUnique({
        where: { id: flagId },
      });

      if (!flag) {
        return res.status(404).json({ error: 'Flag not found' });
      }

      if (!flag.suspendedLeagueParticipationAt) {
        return res.status(400).json({ error: 'Accounts not currently suspended' });
      }

      // Update flag to remove suspension
      const updated = await prisma.leagueCollusionFlag.update({
        where: { id: flagId },
        data: {
          suspendedLeagueParticipationAt: null,
          suspensionReason: null,
        },
      });

      // Log to audit
      logger.info(`[Unsuspension] Accounts unsuspended by admin ${adminUserId}. Reason: ${reason}`);

      // Notify users
      logger.info(`[Notification] Would notify accounts of suspension reversal`);

      res.json(updated);
    } catch (error) {
      logger.error('[Admin] Error unsuspending accounts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/v1/admin/collusion-flags/:flagId/appeals
 * List appeals for a flag.
 * Requires: SECURITY_REVIEW permission
 */
router.get(
  '/collusion-flags/:flagId/appeals',
  requirePermission('SECURITY_REVIEW'),
  async (req: Request, res: Response) => {
    try {
      const { flagId } = req.params;

      const appeals = await prisma.suspensionAppeal.findMany({
        where: { flagId },
        include: {
          account: { select: { email: true, username: true } },
        },
        orderBy: { appealedAt: 'desc' },
      });

      res.json(appeals);
    } catch (error) {
      logger.error('[Admin] Error listing appeals:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/v1/admin/suspension-appeals/:appealId/review
 * Admin reviews a suspension appeal.
 * Requires: ADMIN permission
 */
router.post(
  '/suspension-appeals/:appealId/review',
  requirePermission('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { appealId } = req.params;
      const { status, note } = req.body;
      const adminUserId = (req as any).user.id;

      // Validate status
      if (!['APPROVED', 'REJECTED'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      // Fetch appeal
      const appeal = await prisma.suspensionAppeal.findUnique({
        where: { id: appealId },
        include: { flag: true, account: true },
      });

      if (!appeal) {
        return res.status(404).json({ error: 'Appeal not found' });
      }

      if (appeal.status !== 'PENDING') {
        return res.status(400).json({ error: 'Appeal already reviewed' });
      }

      // Update appeal
      const updated = await prisma.suspensionAppeal.update({
        where: { id: appealId },
        data: {
          status,
          reviewedBy: adminUserId,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      });

      // If approved, unsuspend
      if (status === 'APPROVED') {
        await prisma.leagueCollusionFlag.update({
          where: { id: appeal.flagId },
          data: {
            suspendedLeagueParticipationAt: null,
            suspensionReason: null,
          },
        });

        logger.info(`[Appeal Approved] Appeal ${appealId} approved. Suspension lifted for ${appeal.accountId}`);
      } else {
        logger.info(`[Appeal Rejected] Appeal ${appealId} rejected by admin ${adminUserId}`);
      }

      res.json(updated);
    } catch (error) {
      logger.error('[Admin] Error reviewing appeal:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * Sanitize evidence payload to remove or hash sensitive data.
 */
function sanitizeEvidence(evidence: any): any {
  const sanitized = { ...evidence };

  // Ensure IP subnets are hashed if they were stored raw
  if (sanitized.signals?.sharedIp?.overlappingSubnets) {
    sanitized.signals.sharedIp.overlappingSubnets = sanitized.signals.sharedIp.overlappingSubnets.map((subnet: any) => ({
      ...subnet,
      subnet: hashIpSubnet(subnet.subnet),
    }));
  }

  return sanitized;
}

/**
 * Hash an IP subnet for privacy in evidence.
 */
function hashIpSubnet(subnet: string): string {
  // Simple obfuscation: show only first octet
  const parts = subnet.split('/');
  if (parts[0].includes(':')) {
    // IPv6
    return `[IPv6 hash]/${parts[1] || '64'}`;
  } else {
    // IPv4
    return `[IPv4 hash]/${parts[1] || '24'}`;
  }
}

export default router;
