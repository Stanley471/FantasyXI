/**
 * Names and payload shapes for core domain events published on the
 * in-process event bus (see eventBus.ts, issue #118).
 */

export const GAMEWEEK_UPDATED_EVENT = "gameweek.updated";
export const USER_SIGNED_UP_EVENT = "user.signed_up";

/** Published once a gameweek's live FPL data has been synced and is ready to settle. */
export interface GameweekUpdatedPayload {
  gameweekId: number;
  gameweekFplId: number;
}

/** Published after a new user account is created (password or Google sign-up). */
export interface UserSignedUpPayload {
  userId: string;
  email: string;
  username: string;
}
