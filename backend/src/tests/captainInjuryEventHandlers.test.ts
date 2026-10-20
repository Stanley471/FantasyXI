import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "../services/events/eventBus.js";
import { CAPTAIN_INJURY_ALERT_EVENT } from "../services/events/domainEvents.js";
import {
  CAPTAIN_INJURY_HANDLER_NAMES,
  registerCaptainInjuryEventHandlers,
} from "../services/events/captainInjuryEventHandlers.js";

describe("captain.injury_alert subscriber wiring", () => {
  it("subscribes the email dispatcher in order", () => {
    const bus = new InMemoryEventBus();

    registerCaptainInjuryEventHandlers(bus);

    assert.deepEqual(bus.listSubscriberNames(CAPTAIN_INJURY_ALERT_EVENT), [
      ...CAPTAIN_INJURY_HANDLER_NAMES,
    ]);
  });
});
