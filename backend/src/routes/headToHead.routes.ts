/**
 * Head-to-Head API Routes - #445
 * Real-time H2H match simulator endpoints
 */

import { Router, Request, Response, NextFunction } from 'express';
import { HeadToHeadService } from '../services/headToHeadService';
import { Logger } from '../models/logger';

export function createH2HRouter(h2hService: HeadToHeadService, logger: Logger): Router {
  const router = Router();

  /**
   * POST /api/h2h/match/:leagueId/:homeManagerId/:awayManagerId
   * Initialize a Head-to-Head match between two managers
   */
  router.post(
    '/match/:leagueId/:homeManagerId/:awayManagerId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { leagueId, homeManagerId, awayManagerId } = req.params;
        const { gameweek } = req.query;
        const gameweekNum = gameweek ? parseInt(gameweek as string, 10) : 1;

        if (homeManagerId === awayManagerId) {
          return res.status(400).json({
            error: 'Invalid match',
            message: 'Cannot match manager against themselves',
          });
        }

        const startTime = Date.now();
        const matchData = await h2hService.initializeH2HMatch(
          leagueId,
          homeManagerId,
          awayManagerId,
          gameweekNum
        );

        const queryTime = Date.now() - startTime;

        res.json({
          ...matchData,
          meta: {
            queryTimeMs: queryTime,
            matchId: matchData.matchId,
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * GET /api/h2h/differentials/:matchId
   * Get player differentials between the two competing squads
   */
  router.get(
    '/differentials/:matchId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { matchId } = req.params;
        const differentials = await h2hService.getPlayerDifferentials(matchId);

        res.json({
          matchId,
          differentials,
          meta: {
            totalDifferential: differentials.reduce((sum, d) => sum + (d.scoreDifference || 0), 0),
            keyDifferentials: differentials.slice(0, 5),
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * GET /api/h2h/pitch/:matchId
   * Get interactive pitch heatmap with player touch/event data
   */
  router.get(
    '/pitch/:matchId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { matchId } = req.params;
        const pitchHeatmap = await h2hService.generatePitchHeatmap(matchId);

        res.json(pitchHeatmap);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /api/h2h/live/:matchId
   * Update live match data with real-time events
   */
  router.post(
    '/live/:matchId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { matchId } = req.params;
        const eventData = req.body;

        res.json({
          success: true,
          matchId,
          meta: {
            eventType: eventData.eventType,
            timestamp: new Date(),
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}
