import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '@/middleware/auth';
import { logger } from '@/config/logger';

const router = Router();
const prisma = new PrismaClient();

/**
 * POST /api/v1/user/suspension-appeals
 * User appeals a suspension from a league due to collusion flag.
 * Requires: AUTHENTICATED
 */
router.post(
  '/user/suspension-appeals',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const { flagId, reason } = req.body;

      // Validate input
      if (!flagId || !reason || reason.trim().length === 0) {
        return res.status(400).json({ error: 'flagId and reason are required' });
      }

      if (reason.length > 1000) {
        return res.status(400).json({ error: 'Reason must be ≤1000 characters' });
      }

      // Fetch the flag
      const flag = await prisma.leagueCollusionFlag.findUnique({
        where: { id: flagId },
      });

      if (!flag) {
        return res.status(404).json({ error: 'Flag not found' });
      }

      // Verify the user is affected by this flag
      if (flag.accountAId !== userId && flag.accountBId !== userId) {
        return res.status(403).json({ error: 'You are not associated with this flag' });
      }

      // Verify the accounts are actually suspended
      if (!flag.suspendedLeagueParticipationAt) {
        return res.status(400).json({ error: 'This flag has not resulted in suspension' });
      }

      // Check if user already has a pending appeal for this flag
      const existingAppeal = await prisma.suspensionAppeal.findFirst({
        where: {
          flagId,
          accountId: userId,
          status: 'PENDING',
        },
      });

      if (existingAppeal) {
        return res.status(400).json({ error: 'You already have a pending appeal for this flag' });
      }

      // Create appeal
      const appeal = await prisma.suspensionAppeal.create({
        data: {
          flagId,
          accountId: userId,
          reason,
          status: 'PENDING',
          appealedAt: new Date(),
        },
        include: {
          account: { select: { email: true, username: true } },
          flag: { select: { leagueId: true, confidenceLevel: true, riskScore: true } },
        },
      });

      // Log appeal
      logger.info(
        `[Suspension Appeal] User ${userId} appealed suspension from league ${appeal.flag.leagueId} (flag ${flagId}). Reason: ${reason.substring(0, 100)}...`
      );

      // Notify admins (in production)
      logger.info(`[Notification] Would alert admins of new suspension appeal from ${userId}`);

      res.status(201).json({
        id: appeal.id,
        status: appeal.status,
        appealedAt: appeal.appealedAt,
        message: 'Appeal submitted successfully. An admin will review your appeal within 7 business days.',
      });
    } catch (error) {
      logger.error('[Appeal] Error creating appeal:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/v1/user/suspension-appeals
 * Get all appeals for the authenticated user.
 * Requires: AUTHENTICATED
 */
router.get(
  '/user/suspension-appeals',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;

      const appeals = await prisma.suspensionAppeal.findMany({
        where: { accountId: userId },
        include: {
          flag: {
            select: {
              id: true,
              leagueId: true,
              confidenceLevel: true,
              riskScore: true,
              suspensionReason: true,
              accountAId: true,
              accountBId: true,
            },
          },
        },
        orderBy: { appealedAt: 'desc' },
      });

      // Fetch league names
      const leagueIds = [...new Set(appeals.map((a) => a.flag.leagueId))];
      const leagues = await prisma.league.findMany({
        where: { id: { in: leagueIds } },
        select: { id: true, name: true },
      });

      const leagueMap = new Map(leagues.map((l) => [l.id, l.name]));

      const enriched = appeals.map((appeal) => ({
        ...appeal,
        flag: {
          ...appeal.flag,
          leagueName: leagueMap.get(appeal.flag.leagueId),
        },
      }));

      res.json(enriched);
    } catch (error) {
      logger.error('[Appeal] Error fetching appeals:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/v1/user/suspension-appeals/:appealId
 * Get details of a specific appeal.
 * Requires: AUTHENTICATED, must be the appeal owner
 */
router.get(
  '/user/suspension-appeals/:appealId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const { appealId } = req.params;

      const appeal = await prisma.suspensionAppeal.findUnique({
        where: { id: appealId },
        include: {
          flag: {
            select: {
              id: true,
              leagueId: true,
              confidenceLevel: true,
              riskScore: true,
              suspensionReason: true,
              signalsTriggered: true,
              accountAId: true,
              accountBId: true,
              // Note: evidence is NOT included for regular users
            },
          },
          account: { select: { email: true, username: true } },
        },
      });

      if (!appeal) {
        return res.status(404).json({ error: 'Appeal not found' });
      }

      // Verify ownership
      if (appeal.accountId !== userId) {
        return res.status(403).json({ error: 'You do not have access to this appeal' });
      }

      res.json(appeal);
    } catch (error) {
      logger.error('[Appeal] Error fetching appeal:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/v1/user/suspension-status
 * Check if the user has any active suspensions.
 * Requires: AUTHENTICATED
 */
router.get(
  '/user/suspension-status',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;

      // Find all active suspensions for this user
      const suspensions = await prisma.leagueCollusionFlag.findMany({
        where: {
          OR: [{ accountAId: userId }, { accountBId: userId }],
          suspendedLeagueParticipationAt: { not: null },
          status: { in: ['FLAGGED', 'CONFIRMED'] },
        },
        select: {
          id: true,
          leagueId: true,
          confidenceLevel: true,
          riskScore: true,
          suspendedLeagueParticipationAt: true,
          suspensionReason: true,
        },
      });

      // Fetch league names
      const leagueIds = [...new Set(suspensions.map((s) => s.leagueId))];
      const leagues = await prisma.league.findMany({
        where: { id: { in: leagueIds } },
        select: { id: true, name: true },
      });

      const leagueMap = new Map(leagues.map((l) => [l.id, l.name]));

      const enriched = suspensions.map((suspension) => ({
        ...suspension,
        leagueName: leagueMap.get(suspension.leagueId),
      }));

      res.json({
        suspensions: enriched,
        isActive: enriched.length > 0,
        message:
          enriched.length > 0
            ? `You have ${enriched.length} active suspension(s). You can appeal these suspensions.`
            : 'No active suspensions',
      });
    } catch (error) {
      logger.error('[Appeal] Error checking suspension status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
