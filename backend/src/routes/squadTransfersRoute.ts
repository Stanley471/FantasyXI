import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authMiddleware } from '../middleware/authMiddleware';

interface TransferResponse {
  playerOut: {
    id: string;
    name: string;
    position: string;
    club: string;
    priceAtTransfer: number;
  };
  playerIn: {
    id: string;
    name: string;
    position: string;
    club: string;
    priceAtTransfer: number;
  };
  timestamp: string;
}

interface TransfersEndpointResponse {
  squadId: string;
  gameweek: number;
  masked: boolean;
  maskedReason?: string;
  transfers: TransferResponse[];
  summary: {
    totalTransfers: number;
    freeTransfersUsed: number;
    excessTransfers: number;
    penaltyPoints: number;
  };
}

const TRANSFER_PENALTY_PER_EXCESS = -4; // -4 points per excess transfer

export const squadTransfersRouter = Router();

/**
 * GET /api/squads/:id/transfers?gameweek=:gw
 * 
 * Fetch transfer history for a squad in a specific gameweek.
 * 
 * Query Parameters:
 * - gameweek (required): positive integer, must be within valid range
 * 
 * Response:
 * - Transfers masked if gameweek is current and deadline not passed
 * - Full details visible for past gameweeks and after deadline
 * 
 * Errors:
 * - 400: invalid/missing gameweek
 * - 404: squad not found
 */
squadTransfersRouter.get(
  '/api/squads/:id/transfers',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id: squadId } = req.params;
      const { gameweek } = req.query;

      // Validate gameweek parameter
      if (!gameweek) {
        res.status(400).json({ error: 'Missing required parameter: gameweek' });
        return;
      }

      const gameweekNum = parseInt(gameweek as string, 10);

      if (isNaN(gameweekNum) || gameweekNum <= 0) {
        res.status(400).json({ error: 'gameweek must be a positive integer' });
        return;
      }

      // Fetch the squad
      const squad = await prisma.squad.findUnique({
        where: { id: squadId },
        include: { manager: true },
      });

      if (!squad) {
        res.status(404).json({ error: 'Squad not found' });
        return;
      }

      // Authorization: user can only view their own squad or league-member squads
      // Simplified: only owner or admin can view
      const userId = (req as any).userId;
      if (squad.managerId !== userId && (req as any).userRole !== 'ADMIN') {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      // Fetch gameweek info
      const gameweekInfo = await prisma.gameweek.findUnique({
        where: { number: gameweekNum },
      });

      if (!gameweekInfo) {
        res.status(400).json({ error: 'Invalid gameweek number' });
        return;
      }

      // Determine if transfers should be masked
      const now = new Date();
      const deadlinePassed = now >= gameweekInfo.deadlineAt;
      const isCurrentGameweek = gameweekInfo.status === 'ACTIVE';

      let masked = false;
      let maskedReason: string | undefined;

      if (isCurrentGameweek && !deadlinePassed) {
        masked = true;
        maskedReason = 'Transfers are hidden until the deadline passes';
      }

      // Fetch transfers for squad and gameweek
      const transfers = await prisma.transfer.findMany({
        where: {
          squadId,
          gameweek: gameweekNum,
        },
        include: {
          playerOut: true,
          playerIn: true,
        },
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }], // Deterministic ordering
      });

      let responseTransfers: TransferResponse[] = [];
      let summary = {
        totalTransfers: transfers.length,
        freeTransfersUsed: 0,
        excessTransfers: 0,
        penaltyPoints: 0,
      };

      if (!masked) {
        // Full visibility: show all transfer details
        responseTransfers = transfers.map((t) => ({
          playerOut: {
            id: t.playerOut.id,
            name: t.playerOut.name,
            position: t.playerOut.position,
            club: t.playerOut.club,
            priceAtTransfer: t.priceOutAsInteger,
          },
          playerIn: {
            id: t.playerIn.id,
            name: t.playerIn.name,
            position: t.playerIn.position,
            club: t.playerIn.club,
            priceAtTransfer: t.priceInAsInteger,
          },
          timestamp: t.timestamp.toISOString(),
        }));

        // Calculate penalty
        const freeTransfers = squad.freeTransfersForGameweek ?? 1; // Default 1 per week
        const excessTransfers = Math.max(0, transfers.length - freeTransfers);
        summary.freeTransfersUsed = Math.min(transfers.length, freeTransfers);
        summary.excessTransfers = excessTransfers;
        summary.penaltyPoints = excessTransfers * TRANSFER_PENALTY_PER_EXCESS;
      } else {
        // Masked: no transfer details, no count or penalty leak
        responseTransfers = [];
        summary = {
          totalTransfers: 0,
          freeTransfersUsed: 0,
          excessTransfers: 0,
          penaltyPoints: 0,
        };
      }

      const response: TransfersEndpointResponse = {
        squadId,
        gameweek: gameweekNum,
        masked,
        ...(maskedReason && { maskedReason }),
        transfers: responseTransfers,
        summary,
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching squad transfers:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default squadTransfersRouter;
