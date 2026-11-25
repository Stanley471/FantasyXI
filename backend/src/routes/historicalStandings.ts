/**
 * Historical Standings API Routes
 * Endpoints for retrieving and inspecting historical league standings
 */

import express, { Router, Request, Response, NextFunction } from "express";
import { HistoricalStandingsService } from "../services/league/historicalStandingsService.js";
import { CacheService } from "../services/cache/cacheService.js";
import { Logger } from "../types/index.js";
import { authenticateToken } from "../middleware/auth.js";
import { validateLeagueAccess } from "../middleware/authorization.js";

export function createHistoricalStandingsRouter(
  logger: Logger,
  cacheService: CacheService
): Router {
  const router = express.Router();
  const standingsService = new HistoricalStandingsService(logger, cacheService);

  /**
   * GET /api/standings/historical/:leagueId/:gameweekId
   * Get complete standings snapshot for a specific gameweek
   */
  router.get(
    "/historical/:leagueId/:gameweekId",
    authenticateToken,
    validateLeagueAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { leagueId, gameweekId } = req.params;
        const { verify } = req.query;
        const gw = parseInt(gameweekId, 10);

        if (isNaN(gw) || gw < 1) {
          return res.status(400).json({
            error: "Invalid gameweek",
            message: "Gameweek must be a positive integer",
          });
        }

        const startTime = Date.now();
        const standings = await standingsService.getHistoricalStandings(leagueId, gw);
        const queryTime = Date.now() - startTime;

        if (queryTime > 100) {
          logger.warn(
            `Slow historical query: ${queryTime}ms for league ${leagueId} GW ${gw}`
          );
        }

        let response: any = {
          ...standings,
          meta: {
            ...standings.meta,
            queryTimeMs: queryTime,
          },
        };

        // Optional accuracy verification
        if (verify === "true") {
          const verification = await standingsService.verifyHistoricalAccuracy(
            leagueId,
            gw
          );
          response.verification = verification;
        }

        res.json(response);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * GET /api/standings/trend/:leagueId
   * Get standings snapshots for a range of gameweeks
   */
  router.get(
    "/trend/:leagueId",
    authenticateToken,
    validateLeagueAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { leagueId } = req.params;
        const { from, to } = req.query;

        const fromGw = parseInt(from as string, 10);
        const toGw = parseInt(to as string, 10);

        if (isNaN(fromGw) || isNaN(toGw) || fromGw > toGw) {
          return res.status(400).json({
            error: "Invalid gameweek range",
            message: "from and to must be integers with from <= to",
          });
        }

        if (toGw - fromGw > 38) {
          return res.status(400).json({
            error: "Range too large",
            message: "Maximum range is 38 gameweeks",
          });
        }

        const startTime = Date.now();
        const trends = await standingsService.getHistoricalTrend(
          leagueId,
          fromGw,
          toGw
        );
        const queryTime = Date.now() - startTime;

        res.json({
          leagueId,
          gameweeks: trends,
          meta: {
            totalQueryTimeMs: queryTime,
            count: trends.length,
            averagePerGwMs: Math.round(queryTime / trends.length),
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * GET /api/standings/trajectory/:leagueId/:membershipId
   * Get a member's rank and points progression throughout the season
   */
  router.get(
    "/trajectory/:leagueId/:membershipId",
    authenticateToken,
    validateLeagueAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { leagueId, membershipId } = req.params;

        const startTime = Date.now();
        const trajectory = await standingsService.getManagerTrajectory(
          leagueId,
          membershipId
        );
        const queryTime = Date.now() - startTime;

        if (trajectory.length === 0) {
          return res.json({
            membershipId,
            leagueId,
            trajectory: [],
            meta: {
              queryTimeMs: queryTime,
              gameweeksTracked: 0,
            },
          });
        }

        res.json({
          membershipId,
          leagueId,
          trajectory,
          meta: {
            queryTimeMs: queryTime,
            gameweeksTracked: trajectory.length,
            peakRank: Math.min(...trajectory.map((t) => t.rank)),
            lowestRank: Math.max(...trajectory.map((t) => t.rank)),
            pointsGained: trajectory[trajectory.length - 1]?.points || 0,
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /api/standings/verify/:leagueId/:gameweekId
   * Verify historical data accuracy for a gameweek
   */
  router.post(
    "/verify/:leagueId/:gameweekId",
    authenticateToken,
    validateLeagueAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { leagueId, gameweekId } = req.params;
        const gw = parseInt(gameweekId, 10);

        if (isNaN(gw) || gw < 1) {
          return res.status(400).json({
            error: "Invalid gameweek",
            message: "Gameweek must be a positive integer",
          });
        }

        const verification = await standingsService.verifyHistoricalAccuracy(
          leagueId,
          gw
        );

        res.json({
          leagueId,
          gameweekId: gw,
          ...verification,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /api/standings/precompute/:leagueId/:gameweekId
   * Pre-compute and cache standings (admin only)
   */
  router.post(
    "/precompute/:leagueId/:gameweekId",
    authenticateToken,
    validateLeagueAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { leagueId, gameweekId } = req.params;
        const gw = parseInt(gameweekId, 10);

        if (isNaN(gw) || gw < 1) {
          return res.status(400).json({
            error: "Invalid gameweek",
            message: "Gameweek must be a positive integer",
          });
        }

        const startTime = Date.now();
        await standingsService.preComputeStandings(leagueId, gw);
        const computeTime = Date.now() - startTime;

        res.json({
          success: true,
          leagueId,
          gameweekId: gw,
          precomputeTimeMs: computeTime,
          message: "Standings pre-computed and cached",
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * Error handler for historical standings routes
   */
  router.use((error: any, req: Request, res: Response, next: NextFunction) => {
    logger.error(`Historical standings route error:`, error);

    const statusCode = error.statusCode || 500;
    const message = error.message || "Failed to retrieve standings";

    res.status(statusCode).json({
      error: error.name || "StandingsError",
      message,
      gameweekId: req.params.gameweekId,
      leagueId: req.params.leagueId,
    });
  });

  return router;
}

export default createHistoricalStandingsRouter;
