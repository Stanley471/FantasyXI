/**
 * Names and payload shapes for core domain events published on the
 * in-process event bus (see eventBus.ts, issue #118).
 */

export const GAMEWEEK_UPDATED_EVENT = "gameweek.updated";
export const USER_SIGNED_UP_EVENT = "user.signed_up";
export const SECURITY_TAMPER_DETECTED_EVENT = "SECURITY_TAMPER_DETECTED";
export const LEAGUE_TIER_TRANSITION_COMPLETED_EVENT = "LEAGUE_TIER_TRANSITION_COMPLETED";

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

export interface LeagueTierTransitionMovementSummary {
  leagueId: string;
  leagueSeasonId: string;
  nextLeagueSeasonId: string;
  fromTierId: string;
  toTierId: string;
  rank: number;
  movement: "PROMOTE" | "RELEGATE" | "STAY";
  totalPoints: number;
  goalsScored: number;
  transferHits: number;
}

/** Published when a multi-tier league season transition pipeline completes. */
export interface LeagueTierTransitionCompletedPayload {
  tierGroupId: string;
  season: string;
  nextSeason: string;
  processed: number;
  promotions: number;
  relegations: number;
  alreadyTransitioned: boolean;
  movements: LeagueTierTransitionMovementSummary[];
}

