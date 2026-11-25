import { emailService } from "../services/email/emailService.js";
import type { EmailProviderResult, LeagueInviteEmailPayload } from "../services/email/emailService.js";

/**
 * League Invite Email Queue (issue #495).
 *
 * League invite emails are dispatched off the `league-invite-email` pg-boss
 * queue so POST /api/v1/leagues/:id/invite can respond as soon as the
 * invitation is created, without waiting on the mail provider.
 */

export const LEAGUE_INVITE_QUEUE_NAME = "league-invite-email";
export const LEAGUE_INVITE_RETRY_LIMIT = 3;
export const LEAGUE_INVITE_RETRY_DELAY_SECONDS = 30;

export type LeagueInviteEmailTask = LeagueInviteEmailPayload;

export interface LeagueInviteQueueConfig {
  policy: "stately";
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
}

export function leagueInviteQueueConfig(): LeagueInviteQueueConfig {
  return {
    policy: "stately",
    retryLimit: LEAGUE_INVITE_RETRY_LIMIT,
    retryDelay: LEAGUE_INVITE_RETRY_DELAY_SECONDS,
    retryBackoff: true,
  };
}

/** Executes a single queued league invite email send. */
export async function executeLeagueInviteEmailTask(
  task: LeagueInviteEmailTask
): Promise<EmailProviderResult> {
  return emailService.sendLeagueInviteEmail(task);
}
