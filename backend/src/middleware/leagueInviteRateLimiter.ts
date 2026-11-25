import { RequestHandler } from "express";
import { MemorySlidingWindowStore, SlidingWindowStore } from "./rateLimiter.js";

/**
 * Caps league invite emails at 20 per user per hour (issue #495), so a
 * compromised or careless account can't be used to spam invitations.
 */
const LEAGUE_INVITE_LIMIT = 20;
const LEAGUE_INVITE_WINDOW_MS = 60 * 60 * 1000;

export interface LeagueInviteRateLimiterOptions {
  store?: SlidingWindowStore;
  limit?: number;
  windowMs?: number;
}

export function createLeagueInviteRateLimiter(
  options: LeagueInviteRateLimiterOptions = {}
): RequestHandler {
  const store = options.store ?? new MemorySlidingWindowStore();
  const limit = options.limit ?? LEAGUE_INVITE_LIMIT;
  const windowMs = options.windowMs ?? LEAGUE_INVITE_WINDOW_MS;

  return async (req, res, next) => {
    try {
      if (!req.user?.id) {
        next();
        return;
      }

      const result = await store.consume(
        [{ key: `fantasyxi:rate:{league-invite}:user:${req.user.id}`, limit }],
        windowMs
      );

      res.setHeader("X-RateLimit-Limit", result.limit);
      res.setHeader("X-RateLimit-Remaining", result.remaining);
      if (!result.allowed) {
        res.setHeader("Retry-After", Math.max(1, Math.ceil(result.resetAfterMs / 1000)));
        res.status(429).json({
          success: false,
          message: "Too many league invites sent. Please try again later.",
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Shared limiter instance for POST /leagues/:id/invite. */
export const leagueInviteRateLimiter = createLeagueInviteRateLimiter();
