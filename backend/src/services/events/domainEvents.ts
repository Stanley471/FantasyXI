/**
 * Names and payload shapes for core domain events published on the
 * in-process event bus (see eventBus.ts, issue #118).
 */

export const GAMEWEEK_UPDATED_EVENT = "gameweek.updated";
export const USER_SIGNED_UP_EVENT = "user.signed_up";
export const SECURITY_TAMPER_DETECTED_EVENT = "SECURITY_TAMPER_DETECTED";
export const CAPTAIN_INJURY_ALERT_EVENT = "captain.injury_alert";

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

/** Published when audit chain verification detects cryptographic tampering or link breakage. */
export interface SecurityTamperDetectedPayload {
  corruptRecordId?: string;
  tamperedIndex?: number;
  totalEntries: number;
  error?: string;
  detectedAt: string;
}

/** Published when a player's FPL status changes to injured ('i'), doubtful ('d'), or suspended ('s') prior to deadline. */
export interface CaptainInjuryAlertPayload {
  playerId: number;
  fplId: number;
  playerName: string;
  oldStatus: string;
  newStatus: string;
  news: string | null;
  chanceOfPlayingNextRound: number | null;
  gameweekId: number;
  gameweekName?: string;
  deadline?: Date | string;
}
