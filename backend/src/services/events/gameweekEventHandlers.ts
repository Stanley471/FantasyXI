import { prisma } from "../../config/db.js";
import { ChipType, LeagueStatus, ScoringType } from "../../types/index.js";
import { scoringService } from "../scoring/scoringService.js";
import { squadService } from "../squad/squadService.js";
import { leagueService } from "../league/leagueService.js";
import { eventBus, EventBus } from "./eventBus.js";
import { GAMEWEEK_UPDATED_EVENT, GameweekUpdatedPayload } from "./domainEvents.js";

/**
 * Subscribers to the "gameweek.updated" domain event (issue #118).
 *
 * `jobs/gameweekSettlement.ts` used to import and call the scoring, squad and
 * league services directly and in sequence. It now only publishes one event;
 * these three subscribers react to it independently, so a future subscriber
 * (e.g. a push-notification service) can be added here without touching the
 * settlement job at all.
 *
 * Ordering: subscribers are registered, and therefore run, in the order
 * below - scoring, then free-hit reverts, then league settlement - because
 * league settlement reads squad scores that the scoring subscriber must have
 * already persisted. The in-process bus runs subscribers sequentially for
 * exactly this reason (see eventBus.ts); a real broker's competing consumers
 * would need that dependency expressed as an explicit follow-up event instead.
 */

async function handleScoreSquads({ gameweekId }: GameweekUpdatedPayload): Promise<void> {
  const squads = await prisma.squad.findMany({ select: { id: true } });
  for (const squad of squads) {
    await scoringService.calculateAndPersistSquadScore(squad.id, gameweekId);
  }
}

async function handleRevertFreeHits({ gameweekId }: GameweekUpdatedPayload): Promise<void> {
  const freeHits = await prisma.squadChipUsage.findMany({
    where: { gameweekId, chipType: ChipType.FREE_HIT, revertedAt: null },
    select: { squadId: true },
  });
  for (const usage of freeHits) {
    await squadService.revertFreeHit(usage.squadId, gameweekId);
  }
}

async function handleSettleLeagues({ gameweekId }: GameweekUpdatedPayload): Promise<void> {
  const leagues = await prisma.league.findMany({
    where: {
      status: LeagueStatus.ACTIVE,
      startGameweekId: { lte: gameweekId },
      endGameweekId: { gte: gameweekId },
    },
  });
  for (const league of leagues) {
    if (league.scoringType === ScoringType.HEAD_TO_HEAD) {
      await leagueService.settleH2HGameweek(league.id, gameweekId);
    }
    if (league.endGameweekId === gameweekId) {
      await leagueService.transitionStatus(league.id, LeagueStatus.COMPLETED);
    }
  }
}

/** Handler names, exported so tests can assert on registration without invoking prisma. */
export const GAMEWEEK_HANDLER_NAMES = [
  "scoringService.scoreSquads",
  "squadService.revertFreeHits",
  "leagueService.settleLeagues",
] as const;

let registeredOnDefaultBus = false;

/**
 * Subscribes the three gameweek-update handlers to `bus`. Idempotent for the
 * process-wide default bus (repeated imports must not double-subscribe);
 * tests may pass a fresh `InMemoryEventBus` to inspect subscriptions in
 * isolation, in which case this always subscribes.
 */
export function registerGameweekEventHandlers(bus: EventBus = eventBus): void {
  if (bus === eventBus) {
    if (registeredOnDefaultBus) return;
    registeredOnDefaultBus = true;
  }
  bus.subscribe(GAMEWEEK_UPDATED_EVENT, handleScoreSquads, { name: GAMEWEEK_HANDLER_NAMES[0] });
  bus.subscribe(GAMEWEEK_UPDATED_EVENT, handleRevertFreeHits, { name: GAMEWEEK_HANDLER_NAMES[1] });
  bus.subscribe(GAMEWEEK_UPDATED_EVENT, handleSettleLeagues, { name: GAMEWEEK_HANDLER_NAMES[2] });
}

// Registers on import so `jobs/gameweekSettlement.ts` only needs to publish.
registerGameweekEventHandlers();
