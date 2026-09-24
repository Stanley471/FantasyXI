/**
 * FPL Tracking Daemon Worker
 *
 * Continuously polls the official Fantasy Premier League /bootstrap-static/ API
 * to detect:
 * 1. Player price fluctuations (now_cost deltas in tenths of a million £).
 * 2. Injury and suspension updates (status codes: 'i', 's', 'd', 'u', 'a').
 * 3. News reports and playing chance percentages.
 *
 * Persists changes to the PostgreSQL database (updating Player records and
 * appending to PlayerPriceChange / PlayerStatusHistory audit tables), and
 * emits strongly-typed events ('player:price_change', 'player:injury_update',
 * 'player:status_change') for real-time notification dispatch.
 */

import { EventEmitter } from "node:events";
import { prisma } from "../config/db.js";
import { FplClient } from "../services/fpl/fplClient.js";

export type FplStatusCode = "a" | "d" | "i" | "s" | "u" | string;

export interface PriceChangeEvent {
  playerId: number;
  fplId: number;
  webName: string;
  oldPrice: number;
  newPrice: number;
  diff: number;
  changedAt: Date;
}

export interface InjuryUpdateEvent {
  playerId: number;
  fplId: number;
  webName: string;
  status: FplStatusCode;
  news: string;
  chanceOfPlayingNextRound: number | null;
  changedAt: Date;
}

export interface StatusChangeEvent {
  playerId: number;
  fplId: number;
  webName: string;
  oldStatus: FplStatusCode | null;
  newStatus: FplStatusCode;
  isAvailable: boolean;
  news: string | null;
  changedAt: Date;
}

export interface TrackingPollResult {
  totalScanned: number;
  priceChanges: PriceChangeEvent[];
  statusChanges: StatusChangeEvent[];
  injuryUpdates: InjuryUpdateEvent[];
}

export interface FplTrackingDaemonOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  fplClient?: FplClient;
  pollIntervalMs?: number;
  emitter?: EventEmitter;
}

export class FplTrackingDaemon {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly fplClient: FplClient;
  private readonly pollIntervalMs: number;
  public readonly events: EventEmitter;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: FplTrackingDaemonOptions = {}) {
    this.db = options.db ?? prisma;
    this.fplClient = options.fplClient ?? new FplClient();
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.events = options.emitter ?? new EventEmitter();
  }

  /**
   * Fetches latest FPL elements from /bootstrap-static/ and reconciles against local DB.
   */
  public async pollOnce(): Promise<TrackingPollResult> {
    const bootstrap = await this.fplClient.getBootstrapStatic();
    const elements = bootstrap.elements ?? [];

    const dbPlayers = await this.db.player.findMany({
      select: {
        id: true,
        fplId: true,
        displayName: true,
        price: true,
        status: true,
        news: true,
        chanceOfPlayingNextRound: true,
        isAvailable: true,
      },
    });

    const dbPlayerMap = new Map<number, (typeof dbPlayers)[0]>(
      dbPlayers.map((p: any) => [p.fplId, p])
    );

    const priceChanges: PriceChangeEvent[] = [];
    const statusChanges: StatusChangeEvent[] = [];
    const injuryUpdates: InjuryUpdateEvent[] = [];

    const now = new Date();

    for (const elem of elements) {
      const local = dbPlayerMap.get(elem.id);
      if (!local) continue;

      const newPrice = Number((elem.now_cost / 10).toFixed(1));
      const oldPrice = Number(local.price);
      const priceDiff = Number((newPrice - oldPrice).toFixed(1));

      const newStatus = (elem.status ?? "a") as FplStatusCode;
      const oldStatus = (local.status ?? "a") as FplStatusCode;
      const newNews = elem.news ?? "";
      const oldNews = local.news ?? "";
      const newChance = elem.chance_of_playing_next_round ?? null;
      const oldChance = local.chanceOfPlayingNextRound ?? null;

      let playerNeedsUpdate = false;
      const playerUpdateData: Record<string, unknown> = {};

      // 1. Detect Price Changes
      if (Math.abs(priceDiff) >= 0.05) {
        playerNeedsUpdate = true;
        playerUpdateData.price = newPrice;

        const changePayload: PriceChangeEvent = {
          playerId: local.id,
          fplId: local.fplId,
          webName: elem.web_name,
          oldPrice,
          newPrice,
          diff: priceDiff,
          changedAt: now,
        };
        priceChanges.push(changePayload);

        if (this.db.playerPriceChange) {
          try {
            await this.db.playerPriceChange.create({
              data: {
                playerId: local.id,
                fplId: local.fplId,
                oldPrice,
                newPrice,
                diff: priceDiff,
                changedAt: now,
              },
            });
          } catch (err) {
            console.warn(`[fpl-daemon] Failed to log price change:`, (err as Error).message);
          }
        }

        this.events.emit("player:price_change", changePayload);
      }

      // 2. Detect Status Changes (Availability, doubtful, injured, suspended)
      const statusChanged = newStatus !== oldStatus;
      const newsChanged = newNews !== oldNews || newChance !== oldChance;
      const isAvailable = newStatus === "a";

      if (statusChanged || newsChanged) {
        playerNeedsUpdate = true;
        playerUpdateData.status = newStatus;
        playerUpdateData.news = newNews || null;
        playerUpdateData.chanceOfPlayingNextRound = newChance;
        playerUpdateData.isAvailable = isAvailable;

        if (statusChanged) {
          const statusPayload: StatusChangeEvent = {
            playerId: local.id,
            fplId: local.fplId,
            webName: elem.web_name,
            oldStatus,
            newStatus,
            isAvailable,
            news: newNews || null,
            changedAt: now,
          };
          statusChanges.push(statusPayload);

          if (this.db.playerStatusHistory) {
            try {
              await this.db.playerStatusHistory.create({
                data: {
                  playerId: local.id,
                  fplId: local.fplId,
                  oldStatus,
                  newStatus,
                  news: newNews || null,
                  chanceOfPlayingNextRound: newChance,
                  changedAt: now,
                },
              });
            } catch (err) {
              console.warn(`[fpl-daemon] Failed to log status history:`, (err as Error).message);
            }
          }

          this.events.emit("player:status_change", statusPayload);
        }

        // 3. Emit injury update if player is injured ('i'), doubtful ('d'), suspended ('s'), or news was updated
        if (newStatus === "i" || newStatus === "d" || newStatus === "s" || (newsChanged && newNews)) {
          const injuryPayload: InjuryUpdateEvent = {
            playerId: local.id,
            fplId: local.fplId,
            webName: elem.web_name,
            status: newStatus,
            news: newNews,
            chanceOfPlayingNextRound: newChance,
            changedAt: now,
          };
          injuryUpdates.push(injuryPayload);
          this.events.emit("player:injury_update", injuryPayload);
        }
      }

      if (playerNeedsUpdate) {
        await this.db.player.update({
          where: { id: local.id },
          data: playerUpdateData,
        });
      }
    }

    return {
      totalScanned: elements.length,
      priceChanges,
      statusChanges,
      injuryUpdates,
    };
  }

  /**
   * Retrieves logged price changes from the database.
   */
  public async getPriceChangeHistory(playerId?: number, limit = 50) {
    if (!this.db.playerPriceChange) return [];
    return this.db.playerPriceChange.findMany({
      where: playerId ? { playerId } : undefined,
      orderBy: { changedAt: "desc" },
      take: limit,
      include: { player: { select: { displayName: true, fplId: true } } },
    });
  }

  /**
   * Retrieves logged status and injury updates from the database.
   */
  public async getStatusHistory(playerId?: number, limit = 50) {
    if (!this.db.playerStatusHistory) return [];
    return this.db.playerStatusHistory.findMany({
      where: playerId ? { playerId } : undefined,
      orderBy: { changedAt: "desc" },
      take: limit,
      include: { player: { select: { displayName: true, fplId: true } } },
    });
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
    console.log("[fpl-daemon] FPL injury & price tracking daemon started");
  }

  public stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.pollOnce();
      if (result.priceChanges.length > 0 || result.statusChanges.length > 0) {
        console.log(
          `[fpl-daemon] Poll completed: ${result.priceChanges.length} price changes, ${result.statusChanges.length} status updates`
        );
      }
    } catch (err) {
      console.error("[fpl-daemon] Poll error:", (err as Error).message);
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }
}

export const fplTrackingDaemon = new FplTrackingDaemon();
