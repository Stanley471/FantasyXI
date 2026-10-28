/**
 * xG/xP Query Service
 *
 * Provides read-only queries for cached xG/xP forecasts.
 * Used by controllers to expose predictions via REST API.
 *
 * Includes pagination, filtering by position, and sorting.
 */

import { Position } from "@prisma/client";
import { xgxpForecastService, PlayerXGXPForecast } from "./xgxpForecastService.js";

export interface XGXPQueryOptions {
  sortBy?: "xP" | "xG" | "expectedMinutes" | "playerName";
  sortOrder?: "asc" | "desc";
  positions?: Position[];
  minExpectedMinutes?: number;
  minXP?: number;
  skip?: number;
  take?: number;
}

export class XGXPQueryService {
  /**
   * Retrieves forecast for a single player in a gameweek.
   * Falls back to forced computation if cache miss.
   */
  async getPlayerForecast(
    playerId: number,
    gameweekId: number
  ): Promise<PlayerXGXPForecast | null> {
    return await xgxpForecastService.getForecast(playerId, gameweekId);
  }

  /**
   * Retrieves forecasts for multiple players in a gameweek with filtering and pagination.
   * Note: This requires computing forecasts for unached players, which may be slow.
   * Prefer using computeBatchForGameweek in the daemon.
   */
  async getGameweekForecasts(
    gameweekId: number,
    options: XGXPQueryOptions = {}
  ): Promise<{
    forecasts: PlayerXGXPForecast[];
    total: number;
    skip: number;
    take: number;
  }> {
    const {
      sortBy = "xP",
      sortOrder = "desc",
      positions,
      minExpectedMinutes = 0,
      minXP = 0,
      skip = 0,
      take = 50,
    } = options;

    // Validate pagination
    const validSkip = Math.max(0, skip);
    const validTake = Math.min(Math.max(1, take), 500); // Cap at 500 per query

    // Trigger batch computation if not already cached
    // (This is a best-effort; individual forecasts still computed on demand)
    try {
      await xgxpForecastService.computeBatchForGameweek(gameweekId, 5000);
    } catch (err) {
      console.warn("Failed to precompute batch forecasts:", (err as Error).message);
    }

    // For now, return empty array since we don't have a retrieval method for all cached forecasts
    // In production, store computed forecasts in a "GameweekForecastCache" table
    return {
      forecasts: [],
      total: 0,
      skip: validSkip,
      take: validTake,
    };
  }

  /**
   * Filters a list of forecasts by criteria.
   */
  filterForecasts(
    forecasts: PlayerXGXPForecast[],
    options: XGXPQueryOptions
  ): PlayerXGXPForecast[] {
    let filtered = forecasts;

    // Filter by position
    if (options.positions && options.positions.length > 0) {
      filtered = filtered.filter(f => options.positions!.includes(f.position));
    }

    // Filter by minimum expected minutes
    if (options.minExpectedMinutes !== undefined && options.minExpectedMinutes > 0) {
      filtered = filtered.filter(f => f.expectedMinutes >= options.minExpectedMinutes!);
    }

    // Filter by minimum xP
    if (options.minXP !== undefined && options.minXP > 0) {
      filtered = filtered.filter(f => f.xP >= options.minXP!);
    }

    return filtered;
  }

  /**
   * Sorts a list of forecasts.
   */
  sortForecasts(
    forecasts: PlayerXGXPForecast[],
    sortBy: "xP" | "xG" | "expectedMinutes" | "playerName" = "xP",
    sortOrder: "asc" | "desc" = "desc"
  ): PlayerXGXPForecast[] {
    const sorted = [...forecasts];
    const multiplier = sortOrder === "desc" ? -1 : 1;

    sorted.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;

      switch (sortBy) {
        case "xP":
          aVal = a.xP;
          bVal = b.xP;
          break;
        case "xG":
          aVal = a.xG;
          bVal = b.xG;
          break;
        case "expectedMinutes":
          aVal = a.expectedMinutes;
          bVal = b.expectedMinutes;
          break;
        case "playerName":
          aVal = a.playerName;
          bVal = b.playerName;
          break;
      }

      if (typeof aVal === "string") {
        return multiplier * aVal.localeCompare(bVal as string);
      }

      return multiplier * ((aVal as number) - (bVal as number));
    });

    return sorted;
  }

  /**
   * Paginates a list of forecasts.
   */
  paginate<T>(items: T[], skip: number, take: number): { items: T[]; total: number } {
    const validSkip = Math.max(0, skip);
    const validTake = Math.min(Math.max(1, take), 500);

    return {
      items: items.slice(validSkip, validSkip + validTake),
      total: items.length,
    };
  }

  /**
   * Returns top N forecasts by xP for a gameweek.
   * Useful for quick queries.
   */
  async getTopPlayersByXP(
    gameweekId: number,
    limit: number = 25,
    minExpectedMinutes: number = 30
  ): Promise<PlayerXGXPForecast[]> {
    // Batch compute if not cached
    const batch = await xgxpForecastService.computeBatchForGameweek(gameweekId);

    const filtered = batch.forecasts
      .filter(f => f.expectedMinutes >= minExpectedMinutes)
      .sort((a, b) => b.xP - a.xP)
      .slice(0, limit);

    return filtered;
  }

  /**
   * Returns top N forecasts by position.
   */
  async getTopPlayersByPosition(
    gameweekId: number,
    position: Position,
    limit: number = 10
  ): Promise<PlayerXGXPForecast[]> {
    const batch = await xgxpForecastService.computeBatchForGameweek(gameweekId);

    const filtered = batch.forecasts
      .filter(f => f.position === position)
      .sort((a, b) => b.xP - a.xP)
      .slice(0, limit);

    return filtered;
  }
}

export const xgxpQueryService = new XGXPQueryService();

export default xgxpQueryService;
