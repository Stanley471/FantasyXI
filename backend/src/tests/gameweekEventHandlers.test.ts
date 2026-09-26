import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus, eventBus } from "../services/events/eventBus.js";
import { GAMEWEEK_UPDATED_EVENT } from "../services/events/domainEvents.js";
import {
  GAMEWEEK_HANDLER_NAMES,
  registerGameweekEventHandlers,
} from "../services/events/gameweekEventHandlers.js";

/**
 * Structural test for the gameweek-update pub/sub wiring (issue #118).
 *
 * The handlers themselves call prisma (scoringService, squadService,
 * leagueService), so exercising them end-to-end needs a live database, which
 * this sandbox does not have available for tests (see e.g.
 * scoringService.test.ts, which only exercises the DB-free domain logic).
 * This test instead verifies the piece that is unique to the event-bus
 * refactor and fully testable without a database: `registerGameweekEventHandlers`
 * subscribes exactly the three expected handlers, in the dependency-preserving
 * order documented in gameweekEventHandlers.ts (scoring before league
 * settlement, since league settlement reads the scores scoring persists).
 */
describe("gameweek.updated subscriber wiring (#118)", () => {
  it("subscribes scoring, free-hit-revert and league-settlement handlers in order", () => {
    const bus = new InMemoryEventBus();

    registerGameweekEventHandlers(bus);

    assert.deepEqual(bus.listSubscriberNames(GAMEWEEK_UPDATED_EVENT), [...GAMEWEEK_HANDLER_NAMES]);
  });

  it("does not subscribe handlers for unrelated events", () => {
    const bus = new InMemoryEventBus();
    registerGameweekEventHandlers(bus);
    assert.deepEqual(bus.listSubscriberNames("user.signed_up"), []);
  });

  it("is idempotent on the default process-wide bus", () => {
    // gameweekEventHandlers.ts already ran registerGameweekEventHandlers()
    // once on import (module side effect); calling it again explicitly must
    // not double-subscribe the default bus.
    const before = (eventBus as InMemoryEventBus).listSubscriberNames(GAMEWEEK_UPDATED_EVENT);
    registerGameweekEventHandlers();
    registerGameweekEventHandlers();
    const after = (eventBus as InMemoryEventBus).listSubscriberNames(GAMEWEEK_UPDATED_EVENT);

    assert.deepEqual(after, before);
    assert.deepEqual(after, [...GAMEWEEK_HANDLER_NAMES]);
  });
});
