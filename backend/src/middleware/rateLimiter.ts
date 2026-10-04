import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import { Request, Response } from "express";

function configuredLimit(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRateLimiter(max: number, message: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { success: false, message },
  });
}

/**
 * Standard 429 Error Response Formatter
 */
const createRateLimitHandler = (message: string) => (req: Request, res: Response) => {
  res.status(429).json({
    success: false,
    message,
    retryAfter: res.getHeader("Retry-After") || 60,
  });
};

/**
 * Rate Limiting and Abuse Prevention Middleware for FantasyXI API.
 *
 * 1. Auth Limiter: Protects authentication & registration endpoints from brute force.
 */
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: configuredLimit("AUTH_RATE_LIMIT_MAX", 5), // Max 5 login/register attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many authentication requests from this IP. Please try again after 15 minutes."),
});

/**
 * 2. Financial / Settlement / Payment Limiter:
 * Protects blockchain settlement and payment routes from transaction flooding and replay abuse.
 */
export const financialRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes window
  max: configuredLimit("FINANCIAL_RATE_LIMIT_MAX", 20), // 20 financial operations per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many financial requests. Please wait before submitting additional transactions."),
});

/**
 * 3. Sync & Ingestion Limiter:
 * Protects heavy background sync and daemon polling trigger endpoints.
 */
export const syncRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: configuredLimit("SYNC_RATE_LIMIT_MAX", 10), // 10 sync triggers per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many sync requests. Rate limit reached."),
});

/**
 * 4. Squad & Transfer Limiter:
 * Prevents rapid transfer spam and race conditions during deadline periods.
 */
export const squadRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: configuredLimit("SQUAD_RATE_LIMIT_MAX", 30), // 30 squad operations per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many squad modification requests. Please slow down."),
});

/**
 * 5. General API Limiter:
 * General rate limiter for generic public API routes (issue #139).
 * Protects platform resources and external FPL API polling paths from
 * high-frequency automated scraping / abuse: max 100 requests per minute, per IP.
 */
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: configuredLimit("API_RATE_LIMIT_MAX", 100), // Max 100 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many API requests from this IP. Please try again later."),
});

/** Additional protection for requests that have passed authentication. */
export const authenticatedRateLimiter = createRateLimiter(
  configuredLimit("AUTHENTICATED_RATE_LIMIT_MAX", 60),
  "Too many authenticated API requests from this IP. Please try again later."
);

/** Lower limit for authenticated mutations that are more expensive or stateful. */
export const mutationRateLimiter = createRateLimiter(
  configuredLimit("MUTATION_RATE_LIMIT_MAX", 30),
  "Too many mutation requests from this IP. Please try again later."
);
