import { eventBus, EventBus } from "./eventBus.js";
import { USER_SIGNED_UP_EVENT, UserSignedUpPayload } from "./domainEvents.js";

/**
 * Subscriber to the "user.signed_up" domain event (issue #118).
 *
 * A placeholder for whatever downstream reactions a signup should trigger
 * (welcome email, analytics, referral attribution follow-up, etc.) - the
 * point of the event bus is that `AuthService.register` only has to publish
 * once, and this list can grow without editing the auth service.
 */
async function logUserSignup(payload: UserSignedUpPayload): Promise<void> {
  console.log(`[events] user.signed_up: ${payload.username} (${payload.userId})`);
}

export const USER_HANDLER_NAMES = ["analytics.logUserSignup"] as const;

let registeredOnDefaultBus = false;

export function registerUserEventHandlers(bus: EventBus = eventBus): void {
  if (bus === eventBus) {
    if (registeredOnDefaultBus) return;
    registeredOnDefaultBus = true;
  }
  bus.subscribe(USER_SIGNED_UP_EVENT, logUserSignup, { name: USER_HANDLER_NAMES[0] });
}

registerUserEventHandlers();
