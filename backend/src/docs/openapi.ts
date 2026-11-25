/**
 * OpenAPI 3.0 specification for the FantasyXI v1 REST API.
 *
 * This module is the single source of truth for the API documentation served
 * at /api/docs (development only). It is a hand-written static document
 * derived from the Express routers under src/routes, the controllers, and the
 * Prisma schema — not generated from decorators — so every path, parameter
 * and schema below must match a real route. When a route changes, update
 * this file in the same change; src/tests/openapi.test.ts validates the
 * document against the OpenAPI 3.0 schema and asserts the core operations
 * are present.
 *
 * Auth (see components.securitySchemes):
 * - Bearer JWT in the `Authorization` header for signed-in users, or an
 *   `X-Service-Key` header for service callers (see
 *   src/middleware/authMiddleware.ts). Protected operations accept either.
 * - Mutations honour the `Idempotency-Key` header (see
 *   src/middleware/idempotency.ts): replays return the original response
 *   with `Idempotent-Replayed: true`; reusing a key for a different request
 *   returns 422 and concurrent duplicates return 409.
 * - Inter-service webhooks are signed with `X-Fantasy-Signature`,
 *   `X-Fantasy-Timestamp` and `X-Fantasy-Nonce` (see
 *   src/middleware/internalWebhookAuth.ts). That scheme is documented for
 *   completeness; no public v1 REST operation currently enforces it.
 *
 * Errors use the shared envelope `{ success: false, message }` (see
 * src/middleware/error.middleware.ts). Successful responses use
 * `{ success: true, data, ... }`.
 */

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });

const ok = (schema: string, description = "Success"): Record<string, unknown> => ({
  description,
  content: { "application/json": { schema: ref(schema) } },
});

const created = (schema: string, description = "Created"): Record<string, unknown> => ({
  description,
  content: { "application/json": { schema: ref(schema) } },
});

const errorRef = (name: string): { $ref: string } => ({ $ref: `#/components/responses/${name}` });

const bearerOrServiceKey = [{ bearerAuth: [] }, { serviceKey: [] }];
// Optional auth (optionalAuth middleware): a Bearer token is accepted but
// anonymous callers are allowed, so the empty requirement is an alternative.
const optionalBearer = [{ bearerAuth: [] }, {}];

const idempotencyKeyParam = { $ref: "#/components/parameters/IdempotencyKey" };
const pageParam = { $ref: "#/components/parameters/Page" };
const limitParam = { $ref: "#/components/parameters/Limit" };

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "FantasyXI API",
    version: "1.0.0",
    description:
      "Fantasy football (FPL) platform API: authentication, squads, leagues, players, gameweeks, fixtures, live data, leaderboard, wallet / Stellar escrow payments, analytics and proof-of-reserve. All routes live under /api/v1 unless noted. Interactive documentation is served at /api/docs in development mode only.",
    contact: { name: "FantasyXI" },
    license: { name: "ISC" },
  },
  servers: [
    { url: "http://localhost:5000", description: "Local development server (PORT env, default 5000)" },
  ],
  tags: [
    { name: "Auth", description: "Registration, login, sessions, Google OAuth, passkeys and signing keys." },
    { name: "Players", description: "FPL-synced player data, ownership stats and analytics." },
    { name: "Teams", description: "Premier League teams." },
    { name: "Gameweeks", description: "Gameweek rounds, current gameweek and personal history." },
    { name: "Fixtures", description: "Premier League fixtures." },
    { name: "Squads", description: "Fantasy squads: create, update, chips and scoring." },
    { name: "Leagues", description: "Leagues, invitations, chat, standings and Swiss tournaments." },
    { name: "Live", description: "Live timelines and provisional leaderboards (REST + SSE)." },
    { name: "Leaderboard", description: "Global leaderboard and skill-based matchmaking." },
    { name: "Analytics", description: "Historical performance analytics for the signed-in user." },
    { name: "Financial", description: "Stellar escrow payments, settlement, disputes, refunds and proof-of-reserve." },
    { name: "Admin", description: "Staff-only operations: payouts, audit, reconciliation and security." },
    { name: "Sync", description: "Admin-only FPL data synchronisation." },
    { name: "Webhooks", description: "Outbound webhook endpoints and delivery retries." },
    { name: "SEP-8", description: "Stellar SEP-8 regulated-assets authorisation and KYC." },
    { name: "Health", description: "Service health, root info and JWKS discovery." },
  ],
  paths: {
    "/": {
      get: {
        tags: ["Health"],
        summary: "Service info",
        responses: { "200": ok("ServiceInfo", "Service is running") },
      },
    },
    "/api/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        responses: { "200": ok("HealthResponse", "API is running") },
      },
    },
    "/.well-known/jwks.json": {
      get: {
        tags: ["Health"],
        summary: "Public JSON Web Key Set",
        description: "Public keys for verifying access tokens (issue #332).",
        responses: {
          "200": {
            description: "JWKS document",
            content: { "application/json": { schema: ref("Jwks") } },
          },
        },
      },
    },
    "/api/v1/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a new account",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RegisterRequest") } },
        },
        responses: {
          "201": created("AuthResult", "Account created"),
          "400": errorRef("BadRequest"),
          "409": errorRef("Conflict"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Log in with email and password",
        description:
          "A login from a new device may be challenged: the response then requires POST /auth/login/verify with the emailed 6-digit code.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("LoginRequest") } },
        },
        responses: {
          "200": ok("AuthResult", "Authenticated"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/login/verify": {
      post: {
        tags: ["Auth"],
        summary: "Verify a login challenge code",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("VerifyLoginRequest") } },
        },
        responses: {
          "200": ok("AuthResult", "Challenge verified"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Rotate a refresh token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RefreshRequest") } },
        },
        responses: {
          "200": ok("AuthResult", "Tokens rotated"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Revoke a refresh token (log out)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RefreshRequest") } },
        },
        responses: {
          "200": ok("ApiSuccess", "Logged out"),
          "400": errorRef("BadRequest"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Get the signed-in user's profile",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("UserResponse", "Current user"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/auth/referral-code": {
      get: {
        tags: ["Auth"],
        summary: "Get the signed-in user's referral code",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("ReferralCodeResponse", "Referral code"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/auth/google": {
      get: {
        tags: ["Auth"],
        summary: "Start Google OAuth sign-in",
        description: "Redirects the browser to Google. The callback is GET /auth/google/callback.",
        responses: {
          "302": { description: "Redirect to Google" },
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/google/callback": {
      get: {
        tags: ["Auth"],
        summary: "Google OAuth callback",
        description: "Handles the Google sign-in and account-linking callback.",
        parameters: [
          { name: "code", in: "query", schema: { type: "string" }, description: "OAuth authorisation code from Google." },
          { name: "state", in: "query", schema: { type: "string" }, description: "HMAC-signed OAuth state parameter." },
          { name: "error", in: "query", schema: { type: "string" }, description: "OAuth error, if Google refused." },
        ],
        responses: {
          "200": ok("AuthResult", "Signed in with Google"),
          "302": { description: "Redirect after sign-in" },
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/auth/google/link": {
      post: {
        tags: ["Auth"],
        summary: "Create a Google account link ticket",
        description: "Returns a short-lived URL that starts linking a Google account to the signed-in user.",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("GoogleLinkTicketResponse", "Link ticket created"),
          "401": errorRef("Unauthorized"),
        },
      },
      delete: {
        tags: ["Auth"],
        summary: "Unlink a Google account",
        description: "Requires a password to remain on the account.",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("ApiSuccess", "Google account unlinked"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/auth/google/link/start": {
      get: {
        tags: ["Auth"],
        summary: "Start a Google account link from a ticket",
        parameters: [
          { name: "ticket", in: "query", required: true, schema: { type: "string" }, description: "Short-lived link ticket from POST /auth/google/link." },
        ],
        responses: {
          "302": { description: "Redirect to Google" },
          "400": errorRef("BadRequest"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/password": {
      post: {
        tags: ["Auth"],
        summary: "Add or change the account password",
        security: bearerOrServiceKey,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SetPasswordRequest") } },
        },
        responses: {
          "200": ok("ApiSuccess", "Password set"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/sessions": {
      get: {
        tags: ["Auth"],
        summary: "List active sessions for the signed-in user",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("SessionListResponse", "Active sessions"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/auth/sessions/{sessionId}": {
      delete: {
        tags: ["Auth"],
        summary: "Revoke one session",
        security: bearerOrServiceKey,
        parameters: [
          { name: "sessionId", in: "path", required: true, schema: { type: "string" }, description: "Session id from GET /auth/sessions." },
        ],
        responses: {
          "200": ok("ApiSuccess", "Session revoked"),
          "401": errorRef("Unauthorized"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/auth/sessions/revoke-others": {
      post: {
        tags: ["Auth"],
        summary: "Revoke all sessions except the current one",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("ApiSuccess", "Other sessions revoked"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/auth/sessions/events": {
      get: {
        tags: ["Auth"],
        summary: "Stream session events (SSE)",
        description: "Server-sent events for session activity on the signed-in account.",
        security: bearerOrServiceKey,
        responses: {
          "200": { description: "text/event-stream of session events", content: { "text/event-stream": { schema: { type: "string" } } } },
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/auth/webauthn/login/options": {
      post: {
        tags: ["Auth"],
        summary: "Get passkey login options (usernameless)",
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("PasskeyLoginOptionsRequest") } },
        },
        responses: {
          "200": ok("PasskeyOptionsResponse", "Passkey authentication options"),
          "400": errorRef("BadRequest"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/webauthn/login/verify": {
      post: {
        tags: ["Auth"],
        summary: "Verify a passkey login assertion",
        description: "Passwordless sign-in, or the step-up after a password login.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("PasskeyLoginVerifyRequest") } },
        },
        responses: {
          "200": ok("AuthResult", "Signed in with a passkey"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/webauthn/register/options": {
      post: {
        tags: ["Auth"],
        summary: "Get passkey registration options",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("PasskeyOptionsResponse", "Passkey registration options"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/auth/webauthn/register/verify": {
      post: {
        tags: ["Auth"],
        summary: "Verify passkey registration",
        security: bearerOrServiceKey,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("PasskeyRegisterVerifyRequest") } },
        },
        responses: {
          "201": created("PasskeyCredential", "Passkey registered"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/auth/webauthn/credentials": {
      get: {
        tags: ["Auth"],
        summary: "List the signed-in user's passkeys",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("PasskeyCredentialListResponse", "Registered passkeys"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/auth/webauthn/credentials/{credentialId}": {
      delete: {
        tags: ["Auth"],
        summary: "Delete a passkey",
        security: bearerOrServiceKey,
        parameters: [
          { name: "credentialId", in: "path", required: true, schema: { type: "string" }, description: "Passkey credential id." },
        ],
        responses: {
          "200": ok("ApiSuccess", "Passkey deleted"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/auth/keys/{kid}/revoke": {
      post: {
        tags: ["Auth"],
        summary: "Revoke a JWT signing key on every node",
        description: "ADMIN or service key only.",
        security: bearerOrServiceKey,
        parameters: [
          { name: "kid", in: "path", required: true, schema: { type: "string" }, description: "Key id (kid) of the signing key." },
        ],
        responses: {
          "200": ok("ApiSuccess", "Signing key revoked"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/players": {
      get: {
        tags: ["Players"],
        summary: "Search and filter players",
        parameters: [
          { name: "search", in: "query", schema: { type: "string" }, description: "Matches display name, first name or last name (case-insensitive)." },
          { name: "position", in: "query", schema: { type: "string", enum: ["GKP", "DEF", "MID", "FWD"] } },
          { name: "teamId", in: "query", schema: { type: "integer" } },
          { name: "minPrice", in: "query", schema: { type: "number" }, description: "Minimum price in millions." },
          { name: "maxPrice", in: "query", schema: { type: "number" } },
          { name: "isAvailable", in: "query", schema: { type: "boolean" } },
          { name: "sortBy", in: "query", schema: { type: "string", enum: ["price", "totalPoints", "form", "selectedByPercent"], default: "totalPoints" } },
          { name: "sortOrder", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("PlayerListResponse", "Players page"),
          "400": errorRef("BadRequest"),
        },
      },
    },
    "/api/v1/players/ownership-stats": {
      get: {
        tags: ["Players"],
        summary: "Player ownership statistics",
        responses: {
          "200": ok("PlayerOwnershipStatsResponse", "Ownership stats"),
          "500": errorRef("InternalError"),
        },
      },
    },
    "/api/v1/players/batch-stats": {
      post: {
        tags: ["Players"],
        summary: "Batch player statistics",
        security: bearerOrServiceKey,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("BatchPlayerStatsRequest") } },
        },
        responses: {
          "200": ok("BatchPlayerStatsResponse", "Batch stats"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/players/{id}": {
      get: {
        tags: ["Players"],
        summary: "Get a player by id",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "Player id." },
        ],
        responses: {
          "200": ok("PlayerResponse", "Player"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/players/{id}/analytics": {
      get: {
        tags: ["Players"],
        summary: "Player analytics (expected points and fixture difficulty)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "Player id." },
          { name: "horizon", in: "query", schema: { type: "integer", minimum: 1, default: 5 }, description: "Number of upcoming gameweeks to project over." },
        ],
        responses: {
          "200": ok("PlayerAnalyticsResponse", "Player analytics"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/teams": {
      get: {
        tags: ["Teams"],
        summary: "List Premier League teams",
        responses: {
          "200": ok("TeamListResponse", "Teams"),
          "500": errorRef("InternalError"),
        },
      },
    },
    "/api/v1/teams/{id}": {
      get: {
        tags: ["Teams"],
        summary: "Get a team by id",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "Team id." },
        ],
        responses: {
          "200": ok("TeamResponse", "Team"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/gameweeks": {
      get: {
        tags: ["Gameweeks"],
        summary: "List gameweeks",
        responses: {
          "200": ok("GameweekListResponse", "Gameweeks"),
          "500": errorRef("InternalError"),
        },
      },
    },
    "/api/v1/gameweeks/current": {
      get: {
        tags: ["Gameweeks"],
        summary: "Get the current gameweek",
        responses: {
          "200": ok("GameweekResponse", "Current gameweek"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/gameweeks/history/me": {
      get: {
        tags: ["Gameweeks"],
        summary: "Signed-in user's gameweek history",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("GameweekHistoryResponse", "Personal gameweek history"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/gameweeks/{id}": {
      get: {
        tags: ["Gameweeks"],
        summary: "Get a gameweek by id",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "Gameweek id." },
        ],
        responses: {
          "200": ok("GameweekResponse", "Gameweek"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/fixtures": {
      get: {
        tags: ["Fixtures"],
        summary: "List fixtures",
        parameters: [
          { name: "gameweekId", in: "query", schema: { type: "integer" } },
          { name: "teamId", in: "query", schema: { type: "integer" } },
          { name: "upcoming", in: "query", schema: { type: "boolean" }, description: "Only fixtures that have not started." },
        ],
        responses: {
          "200": ok("FixtureListResponse", "Fixtures"),
          "500": errorRef("InternalError"),
        },
      },
    },
    "/api/v1/squads": {
      post: {
        tags: ["Squads"],
        summary: "Create a fantasy squad",
        description: "15 players (2 GKP, 5 DEF, 5 MID, 3 FWD) within the 100.0 budget. The owner is always derived from the token.",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreateSquadRequest") } },
        },
        responses: {
          "201": created("SquadResponse", "Squad created"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/squads/me": {
      get: {
        tags: ["Squads"],
        summary: "List the signed-in user's squads",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("SquadListResponse", "Own squads"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/squads/{id}": {
      get: {
        tags: ["Squads"],
        summary: "Get a squad by id (public)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("SquadResponse", "Squad"),
          "404": errorRef("NotFound"),
        },
      },
      put: {
        tags: ["Squads"],
        summary: "Update a squad (transfers, captain, bench)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("UpdateSquadRequest") } },
        },
        responses: {
          "200": ok("SquadResponse", "Squad updated"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/squads/{id}/value": {
      get: {
        tags: ["Squads"],
        summary: "Squad valuation (bank, squad and total team value at live FPL prices)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("SquadValuationResponse", "Valuation"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/squads/{id}/chip": {
      post: {
        tags: ["Squads"],
        summary: "Play a chip before the gameweek deadline",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("ActivateChipRequest") } },
        },
        responses: {
          "200": ok("SquadResponse", "Chip activated"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/squads/{id}/chip/{gameweekId}/cancel": {
      post: {
        tags: ["Squads"],
        summary: "Cancel a chip played for a gameweek",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "gameweekId", in: "path", required: true, schema: { type: "integer" } },
          idempotencyKeyParam,
        ],
        responses: {
          "200": ok("SquadResponse", "Chip cancelled"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/squads/user/{userId}": {
      get: {
        tags: ["Squads"],
        summary: "List squads owned by a user (public)",
        parameters: [
          { name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("SquadListResponse", "User squads"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/squads/{id}/calculate-score/{gameweekId}": {
      post: {
        tags: ["Squads"],
        summary: "Calculate a squad's score for a gameweek",
        description: "Persisted scores feed standings, so only ADMIN / SERVICE callers with score:calculate may trigger it.",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "gameweekId", in: "path", required: true, schema: { type: "integer" } },
          idempotencyKeyParam,
        ],
        responses: {
          "200": ok("SquadScoreResponse", "Score calculated"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/leagues": {
      post: {
        tags: ["Leagues"],
        summary: "Create a league",
        description: "The creator is always derived from the token; a client-supplied creatorId is ignored.",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreateLeagueRequest") } },
        },
        responses: {
          "201": created("LeagueResponse", "League created"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
      get: {
        tags: ["Leagues"],
        summary: "Search leagues",
        description: "Private leagues are only visible to their creator and members.",
        security: optionalBearer,
        parameters: [
          { name: "q", in: "query", schema: { type: "string", maxLength: 60 }, description: "Search term." },
          { name: "code", in: "query", schema: { type: "string", pattern: "^[A-Za-z0-9]{4,12}$" }, description: "Invite code." },
          { name: "status", in: "query", schema: { type: "string", enum: ["UPCOMING", "ACTIVE", "COMPLETED", "CANCELLED"] } },
          { name: "scoringType", in: "query", schema: { type: "string", enum: ["CLASSIC", "HEAD_TO_HEAD"] } },
          { name: "minEntryFee", in: "query", schema: { type: "number", minimum: 0 } },
          { name: "maxEntryFee", in: "query", schema: { type: "number", minimum: 0 } },
          { name: "isPrivate", in: "query", schema: { type: "boolean" } },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("LeagueListResponse", "Leagues page"),
          "400": errorRef("BadRequest"),
        },
      },
    },
    "/api/v1/leagues/invitations/{token}": {
      get: {
        tags: ["Leagues"],
        summary: "Preview the league behind an invite link",
        parameters: [
          { name: "token", in: "path", required: true, schema: { type: "string" }, description: "Single-use invitation token." },
        ],
        responses: {
          "200": ok("LeagueInvitationPreviewResponse", "Invitation preview"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/invitations/{token}/accept": {
      post: {
        tags: ["Leagues"],
        summary: "Accept (redeem) a league invitation",
        security: bearerOrServiceKey,
        parameters: [
          { name: "token", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("JoinLeagueRequest") } },
        },
        responses: {
          "200": ok("LeagueMemberResponse", "Invitation accepted"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
        },
      },
    },
    "/api/v1/leagues/{id}": {
      get: {
        tags: ["Leagues"],
        summary: "Get a league by id (public)",
        description: "The invite code is only returned to the creator.",
        security: optionalBearer,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("LeagueResponse", "League"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{id}/join": {
      post: {
        tags: ["Leagues"],
        summary: "Join a league",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("JoinLeagueRequest") } },
        },
        responses: {
          "200": ok("LeagueMemberResponse", "Joined"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{id}/members": {
      get: {
        tags: ["Leagues"],
        summary: "List league members (public)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("LeagueMemberListResponse", "Members"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{id}/standings": {
      get: {
        tags: ["Leagues"],
        summary: "League standings (public)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "gameweekId", in: "query", schema: { type: "integer" }, description: "Standings as of a gameweek; omit for overall." },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("LeagueStandingsResponse", "Standings"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{id}/live": {
      get: {
        tags: ["Leagues"],
        summary: "Stream live league standings and matchday events (SSE)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "text/event-stream of live standings and events", content: { "text/event-stream": { schema: { type: "string" } } } },
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{id}/h2h-standings": {
      get: {
        tags: ["Leagues"],
        summary: "Head-to-head league table (public)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("H2HStandingsResponse", "Head-to-head standings"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{id}/cancel": {
      post: {
        tags: ["Leagues"],
        summary: "Cancel a league (creator only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        responses: {
          "200": ok("LeagueResponse", "League cancelled"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{id}/invitations": {
      post: {
        tags: ["Leagues"],
        summary: "Create a league invitation (creator only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreateLeagueInvitationRequest") } },
        },
        responses: {
          "201": created("LeagueInvitationResponse", "Invitation created"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
      get: {
        tags: ["Leagues"],
        summary: "List a league's invitations (creator only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("LeagueInvitationListResponse", "Invitations"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{id}/invitations/{invitationId}": {
      delete: {
        tags: ["Leagues"],
        summary: "Revoke a league invitation (creator only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "invitationId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("ApiSuccess", "Invitation revoked"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/chat/messages": {
      get: {
        tags: ["Leagues"],
        summary: "League chat history (members only, newest first)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "before", in: "query", schema: { type: "string", format: "date-time" }, description: "Return messages created before this timestamp (cursor paging)." },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: {
          "200": ok("ChatMessageListResponse", "Chat messages"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
      post: {
        tags: ["Leagues"],
        summary: "Post a league chat message (members only)",
        description: "Real-time delivery is via WebSocket at /api/v1/leagues/:leagueId/chat/ws.",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("PostChatMessageRequest") } },
        },
        responses: {
          "201": created("ChatMessageResponse", "Message posted"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/payment-requirement": {
      get: {
        tags: ["Financial"],
        summary: "Payment requirement for joining a league",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "squadId", in: "query", required: true, schema: { type: "string", format: "uuid" }, description: "Squad that will enter the league." },
        ],
        responses: {
          "200": ok("PaymentRequirementResponse", "Payment requirement"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/submit-payment": {
      post: {
        tags: ["Financial"],
        summary: "Submit a league entry-fee payment",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SubmitPaymentRequest") } },
        },
        responses: {
          "200": ok("PaymentSubmissionResponse", "Payment submitted"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/verify-payment": {
      post: {
        tags: ["Financial"],
        summary: "Verify a league entry-fee payment on-chain",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("VerifyPaymentRequest") } },
        },
        responses: {
          "200": ok("PaymentVerificationResponse", "Payment verification result"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/settlement-plan": {
      get: {
        tags: ["Financial"],
        summary: "Settlement plan for a league",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("SettlementPlanResponse", "Settlement plan"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/settle": {
      post: {
        tags: ["Financial"],
        summary: "Execute settlement for a league (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ExecuteSettlementRequest") } },
        },
        responses: {
          "200": ok("SettlementResponse", "Settlement executed"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/reconcile-deposit": {
      post: {
        tags: ["Financial"],
        summary: "Self-service deposit reconciliation",
        description: "Checks the escrow contract directly for the caller's own deposit when the wallet success callback never reached submit/verify.",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("ReconcileDepositRequest") } },
        },
        responses: {
          "200": ok("ReconcileDepositResponse", "Reconciliation result"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/reconcile": {
      get: {
        tags: ["Financial"],
        summary: "Reconcile a league's finances (financial:reconcile permission)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("LeagueReconciliationResponse", "Reconciliation report"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/swiss/init": {
      post: {
        tags: ["Leagues"],
        summary: "Initialise a Swiss-system tournament for a league",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SwissInitRequest") } },
        },
        responses: {
          "200": ok("SwissTournamentResponse", "Swiss tournament initialised"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/swiss/standings": {
      get: {
        tags: ["Leagues"],
        summary: "Swiss tournament standings",
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("SwissStandingsResponse", "Swiss standings"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/swiss/current-round": {
      get: {
        tags: ["Leagues"],
        summary: "Current Swiss tournament round",
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("SwissRoundResponse", "Current round"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/swiss/rounds/advance": {
      post: {
        tags: ["Leagues"],
        summary: "Advance the Swiss tournament to the next round",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SwissAdvanceRequest") } },
        },
        responses: {
          "200": ok("SwissRoundResponse", "Round advanced"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/swiss/rounds/{round}/resolve": {
      post: {
        tags: ["Leagues"],
        summary: "Resolve a Swiss tournament round",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "round", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SwissResolveRequest") } },
        },
        responses: {
          "200": ok("SwissRoundResponse", "Round resolved"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/live/timeline/{gameweekId}": {
      get: {
        tags: ["Live"],
        summary: "Live timeline snapshot for a gameweek",
        parameters: [
          { name: "gameweekId", in: "path", required: true, schema: { type: "integer" } },
        ],
        responses: {
          "200": ok("LiveTimelineResponse", "Live timeline"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/live/timeline/{gameweekId}/stream": {
      get: {
        tags: ["Live"],
        summary: "Stream the live timeline for a gameweek (SSE)",
        parameters: [
          { name: "gameweekId", in: "path", required: true, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "text/event-stream of live timeline events", content: { "text/event-stream": { schema: { type: "string" } } } },
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/live/leaderboard/{leagueId}": {
      get: {
        tags: ["Live"],
        summary: "Live provisional leaderboard for a league",
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("LiveLeaderboardResponse", "Provisional leaderboard"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/live/leaderboard/{leagueId}/stream": {
      get: {
        tags: ["Live"],
        summary: "Stream live provisional leaderboard deltas for a league (SSE)",
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "text/event-stream of leaderboard deltas", content: { "text/event-stream": { schema: { type: "string" } } } },
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leaderboard": {
      get: {
        tags: ["Leaderboard"],
        summary: "Global leaderboard",
        description: "Public; signed-in viewers also get their own position.",
        security: optionalBearer,
        parameters: [
          { name: "q", in: "query", schema: { type: "string", maxLength: 100 }, description: "Search squads by name or username." },
          { name: "gameweekId", in: "query", schema: { type: "integer", minimum: 1 }, description: "Gameweek leaderboard instead of overall." },
          pageParam,
          { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 }, description: "Items per page." },
        ],
        responses: {
          "200": ok("LeaderboardResponse", "Leaderboard page"),
          "400": errorRef("BadRequest"),
        },
      },
    },
    "/api/v1/leaderboard/matchmaking": {
      get: {
        tags: ["Leaderboard"],
        summary: "Skill-based matchmaking candidates for the signed-in user",
        security: bearerOrServiceKey,
        parameters: [
          { name: "tolerance", in: "query", schema: { type: "integer", minimum: 100, maximum: 1000, default: 200 }, description: "Rating tolerance window." },
        ],
        responses: {
          "200": ok("MatchmakingCandidatesResponse", "Matchmaking candidates"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/leaderboard/matchmaking/join": {
      post: {
        tags: ["Leaderboard"],
        summary: "Join the matchmaking queue",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("JoinMatchmakingRequest") } },
        },
        responses: {
          "200": ok("MatchmakingQueueResponse", "Queued for matchmaking"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/analytics/me/performance": {
      get: {
        tags: ["Analytics"],
        summary: "Historical performance dashboard for the signed-in user",
        description: "Per-gameweek, cumulative and rolling points benchmarked against the platform average. Defaults to the user's first squad when squadId is omitted.",
        security: bearerOrServiceKey,
        parameters: [
          { name: "squadId", in: "query", schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("PerformanceResponse", "Performance data"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/proof-of-reserve": {
      get: {
        tags: ["Financial"],
        summary: "Latest public proof-of-reserve snapshot",
        description: "Public: latest reserve roots and totals. No participant data is exposed; returns 503 until the first snapshot is generated.",
        responses: {
          "200": ok("ProofOfReserveResponse", "Proof-of-reserve snapshot"),
          "503": { description: "No proof-of-reserve snapshot has been generated yet", content: { "application/json": { schema: ref("ApiError") } } },
        },
      },
    },
    "/api/v1/financial/requirement": {
      get: {
        tags: ["Financial"],
        summary: "Payment requirement (top-level financial route)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "squadId", in: "query", schema: { type: "string", format: "uuid" }, description: "Squad that will enter the league. Also accepted in the request body." },
        ],
        responses: {
          "200": ok("PaymentRequirementResponse", "Payment requirement"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/financial/simulate-deposit": {
      post: {
        tags: ["Financial"],
        summary: "Simulate a Soroban league deposit (fees and footprint)",
        description: "Read-only simulation; no transaction is submitted.",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SimulateDepositRequest") } },
        },
        responses: {
          "200": ok("SimulateDepositResponse", "Deposit simulation"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/financial/submit": {
      post: {
        tags: ["Financial"],
        summary: "Submit a payment",
        description: "Private high-roller leagues require a zero-knowledge buy-in range proof with each deposit.",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SubmitPaymentRequest") } },
        },
        responses: {
          "200": ok("PaymentSubmissionResponse", "Payment submitted"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/financial/verify": {
      post: {
        tags: ["Financial"],
        summary: "Verify a payment on-chain",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("VerifyPaymentRequest") } },
        },
        responses: {
          "200": ok("PaymentVerificationResponse", "Payment verification result"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/financial/settlement-plan": {
      get: {
        tags: ["Financial"],
        summary: "Settlement plan (top-level financial route)",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("SettlementPlanResponse", "Settlement plan"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/financial/settle": {
      post: {
        tags: ["Financial"],
        summary: "Execute settlement (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ExecuteSettlementRequest") } },
        },
        responses: {
          "200": ok("SettlementResponse", "Settlement executed"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/financial/affiliate-dashboard": {
      get: {
        tags: ["Financial"],
        summary: "Affiliate dashboard for the signed-in user",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("AffiliateDashboardResponse", "Affiliate dashboard"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/financial/reconcile-deposit": {
      post: {
        tags: ["Financial"],
        summary: "Self-service deposit reconciliation (top-level financial route)",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("ReconcileDepositRequest") } },
        },
        responses: {
          "200": ok("ReconcileDepositResponse", "Reconciliation result"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/financial/refund-claim/{txHash}/challenge": {
      get: {
        tags: ["Financial"],
        summary: "Get a deposit refund-claim challenge for a transaction",
        security: bearerOrServiceKey,
        parameters: [
          { name: "txHash", in: "path", required: true, schema: { type: "string" }, description: "Stellar transaction hash of the deposit." },
        ],
        responses: {
          "200": ok("RefundClaimChallengeResponse", "Refund-claim challenge"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/financial/refund-claim/exceptions": {
      get: {
        tags: ["Financial"],
        summary: "List the signed-in user's deposit exceptions",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("DepositExceptionListResponse", "Deposit exceptions"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/financial/refund-claim": {
      post: {
        tags: ["Financial"],
        summary: "Submit a deposit refund claim",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SubmitRefundClaimRequest") } },
        },
        responses: {
          "200": ok("RefundClaimResponse", "Refund claim submitted"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/financial/reconcile": {
      get: {
        tags: ["Financial"],
        summary: "Reconcile league finances (financial:reconcile permission)",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("LeagueReconciliationResponse", "Reconciliation report"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/financial/storage-rent/status": {
      get: {
        tags: ["Financial"],
        summary: "Soroban contract storage-rent status (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "contractId", in: "query", schema: { type: "string" }, description: "Contract to inspect; defaults to the Stellar escrow contract." },
        ],
        responses: {
          "200": ok("StorageRentStatusResponse", "Storage-rent status"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/financial/storage-rent/recover": {
      post: {
        tags: ["Financial"],
        summary: "Trigger Soroban storage-rent recovery (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("StorageRentRecoverRequest") } },
        },
        responses: {
          "200": ok("StorageRentRecoverResponse", "Recovery triggered"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/financial/merkle-settle": {
      post: {
        tags: ["Financial"],
        summary: "Execute a Merkle-tree settlement (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("MerkleSettleRequest") } },
        },
        responses: {
          "200": ok("SettlementResponse", "Merkle settlement executed"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/financial/disputes": {
      post: {
        tags: ["Financial"],
        summary: "File a payment dispute",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("FileDisputeRequest") } },
        },
        responses: {
          "201": created("DisputeResponse", "Dispute filed"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
      get: {
        tags: ["Financial"],
        summary: "List disputes for a league",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "query", schema: { type: "string", format: "uuid" }, description: "League to list disputes for." },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("DisputeListResponse", "Disputes"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/financial/disputes/{disputeId}/evidence": {
      post: {
        tags: ["Financial"],
        summary: "Add evidence to a dispute",
        security: bearerOrServiceKey,
        parameters: [
          { name: "disputeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("AddDisputeEvidenceRequest") } },
        },
        responses: {
          "200": ok("DisputeResponse", "Evidence added"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/financial/disputes/{disputeId}/resolve-payout": {
      post: {
        tags: ["Financial"],
        summary: "Resolve a dispute by paying out (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "disputeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ResolveDisputeRequest") } },
        },
        responses: {
          "200": ok("DisputeResponse", "Dispute resolved with payout"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/financial/disputes/{disputeId}/resolve-refund": {
      post: {
        tags: ["Financial"],
        summary: "Resolve a dispute by refunding (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "disputeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ResolveDisputeRequest") } },
        },
        responses: {
          "200": ok("DisputeResponse", "Dispute resolved with refund"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/financial/disputes/{disputeId}/reject": {
      post: {
        tags: ["Financial"],
        summary: "Reject a dispute (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "disputeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ResolveDisputeRequest") } },
        },
        responses: {
          "200": ok("DisputeResponse", "Dispute rejected"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/requirement": {
      get: {
        tags: ["Financial"],
        summary: "Payment requirement (nested under a league)",
        description: "Same handler as GET /leagues/{leagueId}/payment-requirement, mounted under /financial.",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "squadId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("PaymentRequirementResponse", "Payment requirement"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/simulate-deposit": {
      post: {
        tags: ["Financial"],
        summary: "Simulate a deposit (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SimulateDepositRequest") } },
        },
        responses: {
          "200": ok("SimulateDepositResponse", "Deposit simulation"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/submit": {
      post: {
        tags: ["Financial"],
        summary: "Submit a payment (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SubmitPaymentRequest") } },
        },
        responses: {
          "200": ok("PaymentSubmissionResponse", "Payment submitted"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/verify": {
      post: {
        tags: ["Financial"],
        summary: "Verify a payment (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("VerifyPaymentRequest") } },
        },
        responses: {
          "200": ok("PaymentVerificationResponse", "Payment verification result"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/settlement-plan": {
      get: {
        tags: ["Financial"],
        summary: "Settlement plan (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("SettlementPlanResponse", "Settlement plan"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/settle": {
      post: {
        tags: ["Financial"],
        summary: "Execute settlement (nested under a league, ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ExecuteSettlementRequest") } },
        },
        responses: {
          "200": ok("SettlementResponse", "Settlement executed"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/affiliate-dashboard": {
      get: {
        tags: ["Financial"],
        summary: "Affiliate dashboard (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("AffiliateDashboardResponse", "Affiliate dashboard"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/reconcile-deposit": {
      post: {
        tags: ["Financial"],
        summary: "Self-service deposit reconciliation (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("ReconcileDepositRequest") } },
        },
        responses: {
          "200": ok("ReconcileDepositResponse", "Reconciliation result"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/refund-claim/{txHash}/challenge": {
      get: {
        tags: ["Financial"],
        summary: "Refund-claim challenge (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "txHash", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": ok("RefundClaimChallengeResponse", "Refund-claim challenge"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/refund-claim/exceptions": {
      get: {
        tags: ["Financial"],
        summary: "Own deposit exceptions (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("DepositExceptionListResponse", "Deposit exceptions"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/refund-claim": {
      post: {
        tags: ["Financial"],
        summary: "Submit a deposit refund claim (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SubmitRefundClaimRequest") } },
        },
        responses: {
          "200": ok("RefundClaimResponse", "Refund claim submitted"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/reconcile": {
      get: {
        tags: ["Financial"],
        summary: "Reconcile league finances (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("LeagueReconciliationResponse", "Reconciliation report"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/storage-rent/status": {
      get: {
        tags: ["Financial"],
        summary: "Storage-rent status (nested under a league, ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "contractId", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": ok("StorageRentStatusResponse", "Storage-rent status"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/storage-rent/recover": {
      post: {
        tags: ["Financial"],
        summary: "Trigger storage-rent recovery (nested under a league, ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("StorageRentRecoverRequest") } },
        },
        responses: {
          "200": ok("StorageRentRecoverResponse", "Recovery triggered"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/merkle-settle": {
      post: {
        tags: ["Financial"],
        summary: "Execute a Merkle-tree settlement (nested under a league, ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("MerkleSettleRequest") } },
        },
        responses: {
          "200": ok("SettlementResponse", "Merkle settlement executed"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/disputes": {
      post: {
        tags: ["Financial"],
        summary: "File a payment dispute (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("FileDisputeRequest") } },
        },
        responses: {
          "201": created("DisputeResponse", "Dispute filed"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
      get: {
        tags: ["Financial"],
        summary: "List disputes (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("DisputeListResponse", "Disputes"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/disputes/{disputeId}/evidence": {
      post: {
        tags: ["Financial"],
        summary: "Add evidence to a dispute (nested under a league)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "disputeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("AddDisputeEvidenceRequest") } },
        },
        responses: {
          "200": ok("DisputeResponse", "Evidence added"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/disputes/{disputeId}/resolve-payout": {
      post: {
        tags: ["Financial"],
        summary: "Resolve a dispute by paying out (nested under a league, ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "disputeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ResolveDisputeRequest") } },
        },
        responses: {
          "200": ok("DisputeResponse", "Dispute resolved with payout"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/disputes/{disputeId}/resolve-refund": {
      post: {
        tags: ["Financial"],
        summary: "Resolve a dispute by refunding (nested under a league, ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "disputeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ResolveDisputeRequest") } },
        },
        responses: {
          "200": ok("DisputeResponse", "Dispute resolved with refund"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/leagues/{leagueId}/financial/disputes/{disputeId}/reject": {
      post: {
        tags: ["Financial"],
        summary: "Reject a dispute (nested under a league, ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "disputeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: false,
          content: { "application/json": { schema: ref("ResolveDisputeRequest") } },
        },
        responses: {
          "200": ok("DisputeResponse", "Dispute rejected"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/admin/tenants": {
      get: {
        tags: ["Admin"],
        summary: "List all active tenants (admin only)",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("TenantListResponse", "Active tenants"),
          "401": errorRef("Unauthorized"),
          "500": errorRef("InternalError"),
        },
      },
      post: {
        tags: ["Admin"],
        summary: "Create a new tenant (admin only)",
        security: bearerOrServiceKey,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreateTenantRequest") } },
        },
        responses: {
          "201": created("TenantResponse", "Tenant created"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "500": errorRef("InternalError"),
        },
      },
    },
    "/api/v1/admin/tenant-stats": {
      get: {
        tags: ["Admin"],
        summary: "Tenant boundary violation statistics (last 24 hours)",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("TenantStatsResponse", "Boundary statistics"),
          "401": errorRef("Unauthorized"),
          "500": errorRef("InternalError"),
        },
      },
    },
    "/api/v1/admin/payouts/dead-letter": {
      get: {
        tags: ["Admin"],
        summary: "List failed payouts in the dead-letter queue",
        description: "Requires payout:read (ADMIN / MODERATOR).",
        security: bearerOrServiceKey,
        parameters: [pageParam, limitParam],
        responses: {
          "200": ok("FailedPayoutListResponse", "Failed payouts"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/admin/payouts/dead-letter/{id}": {
      get: {
        tags: ["Admin"],
        summary: "Get one failed payout",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": ok("FailedPayoutResponse", "Failed payout"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/admin/payouts/dead-letter/{id}/retry": {
      post: {
        tags: ["Admin"],
        summary: "Retry a failed payout (ADMIN only, payout:manage)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          idempotencyKeyParam,
        ],
        responses: {
          "200": ok("FailedPayoutResponse", "Payout retry started"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/admin/payouts/dead-letter/{id}/discard": {
      post: {
        tags: ["Admin"],
        summary: "Discard a failed payout without paying (ADMIN only, payout:manage)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          idempotencyKeyParam,
        ],
        responses: {
          "200": ok("FailedPayoutResponse", "Payout discarded"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/admin/audit/financial": {
      get: {
        tags: ["Admin"],
        summary: "List the financial audit log (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [pageParam, limitParam],
        responses: {
          "200": ok("FinancialAuditLogResponse", "Audit log entries"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/admin/audit/verify": {
      get: {
        tags: ["Admin"],
        summary: "Verify the financial audit hash chain (ADMIN only)",
        description: "Verifies the SHA-256 hash chain and flags anomalies.",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("AuditVerifyResponse", "Chain verification result"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/admin/reconciliation/ledger": {
      post: {
        tags: ["Admin"],
        summary: "Run an on-demand PostgreSQL vs Stellar reconciliation report",
        security: bearerOrServiceKey,
        parameters: [
          { name: "format", in: "query", schema: { type: "string", enum: ["json", "markdown"], default: "json" } },
          idempotencyKeyParam,
        ],
        responses: {
          "200": ok("LedgerReconciliationResponse", "Reconciliation report"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/admin/transactions/{txHash}": {
      get: {
        tags: ["Admin"],
        summary: "Transaction coordinator state for a hash",
        security: bearerOrServiceKey,
        parameters: [
          { name: "txHash", in: "path", required: true, schema: { type: "string" }, description: "Transaction hash." },
        ],
        responses: {
          "200": ok("CoordinatedTransactionResponse", "Coordinator state"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/admin/scoring/gameweeks/{gameweekId}/retroactive-adjustments": {
      post: {
        tags: ["Admin"],
        summary: "Apply a retroactive scoring adjustment for a gameweek",
        description: "Requires score:calculate.",
        security: bearerOrServiceKey,
        parameters: [
          { name: "gameweekId", in: "path", required: true, schema: { type: "integer" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RetroactiveAdjustmentRequest") } },
        },
        responses: {
          "200": ok("RetroactiveAdjustmentResponse", "Adjustment applied"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "409": errorRef("Conflict"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/admin/security/anomalies": {
      get: {
        tags: ["Admin"],
        summary: "Failed-login spikes and new-device/new-IP logins (admin review)",
        security: bearerOrServiceKey,
        parameters: [pageParam, limitParam],
        responses: {
          "200": ok("SecurityAnomaliesResponse", "Security anomalies"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/admin/security/sybil/leagues/{leagueId}": {
      get: {
        tags: ["Admin"],
        summary: "Suspected multi-account clusters for a league (ADMIN only)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "refresh", in: "query", schema: { type: "boolean" }, description: "Recompute the report instead of serving the cached one." },
        ],
        responses: {
          "200": ok("SybilReportResponse", "Sybil report"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/admin/leagues/{leagueId}/h2h-anomalies": {
      get: {
        tags: ["Admin"],
        summary: "Head-to-head anomalies for a league",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": ok("H2HAnomaliesResponse", "Head-to-head anomalies"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/admin/leagues/recalculate-standings": {
      post: {
        tags: ["Admin"],
        summary: "Bulk-recalculate every CLASSIC league's standings",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RecalculateStandingsRequest") } },
        },
        responses: {
          "200": ok("RecalculateStandingsResponse", "Standings recalculated"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/admin/leagues/tier-groups": {
      post: {
        tags: ["Admin"],
        summary: "Create a league tier group",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreateTierGroupRequest") } },
        },
        responses: {
          "201": created("TierGroupResponse", "Tier group created"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/admin/leagues/tier-groups/{groupId}/tiers": {
      post: {
        tags: ["Admin"],
        summary: "Create a tier inside a tier group",
        security: bearerOrServiceKey,
        parameters: [
          { name: "groupId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreateTierRequest") } },
        },
        responses: {
          "201": created("TierResponse", "Tier created"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/admin/leagues/tier-groups/{groupId}/season-end-transitions": {
      post: {
        tags: ["Admin"],
        summary: "Apply season-end tier transitions for a tier group",
        security: bearerOrServiceKey,
        parameters: [
          { name: "groupId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          idempotencyKeyParam,
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SeasonEndTransitionsRequest") } },
        },
        responses: {
          "200": ok("SeasonEndTransitionsResponse", "Transitions applied"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "422": errorRef("UnprocessableEntity"),
        },
      },
    },
    "/api/v1/admin/ledger-audits": {
      get: {
        tags: ["Admin"],
        summary: "List ledger audit reports (ADMIN / MODERATOR)",
        security: bearerOrServiceKey,
        parameters: [pageParam, limitParam],
        responses: {
          "200": ok("LedgerAuditReportListResponse", "Ledger audit reports"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
        },
      },
    },
    "/api/v1/admin/sync/bootstrap": {
      post: {
        tags: ["Sync"],
        summary: "Bootstrap FPL data (ADMIN / MODERATOR, fpl:sync)",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        responses: {
          "200": ok("SyncResponse", "Bootstrap started"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/admin/sync/fixtures": {
      post: {
        tags: ["Sync"],
        summary: "Sync fixtures from FPL (ADMIN / MODERATOR, fpl:sync)",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        responses: {
          "200": ok("SyncResponse", "Fixtures synced"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/admin/sync/gameweek/{id}": {
      post: {
        tags: ["Sync"],
        summary: "Sync live data for a gameweek (ADMIN / MODERATOR, fpl:sync)",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "Gameweek id." },
          idempotencyKeyParam,
        ],
        responses: {
          "200": ok("SyncResponse", "Gameweek synced"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/sync/bootstrap": {
      post: {
        tags: ["Sync"],
        summary: "Bootstrap FPL data (alias of /admin/sync/bootstrap)",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        responses: {
          "200": ok("SyncResponse", "Bootstrap started"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/sync/fixtures": {
      post: {
        tags: ["Sync"],
        summary: "Sync fixtures from FPL (alias of /admin/sync/fixtures)",
        security: bearerOrServiceKey,
        parameters: [idempotencyKeyParam],
        responses: {
          "200": ok("SyncResponse", "Fixtures synced"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/sync/gameweek/{id}": {
      post: {
        tags: ["Sync"],
        summary: "Sync live data for a gameweek (alias of /admin/sync/gameweek/{id})",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "Gameweek id." },
          idempotencyKeyParam,
        ],
        responses: {
          "200": ok("SyncResponse", "Gameweek synced"),
          "401": errorRef("Unauthorized"),
          "403": errorRef("Forbidden"),
          "404": errorRef("NotFound"),
          "429": errorRef("TooManyRequests"),
        },
      },
    },
    "/api/v1/webhooks/endpoints": {
      post: {
        tags: ["Webhooks"],
        summary: "Create a webhook endpoint",
        security: bearerOrServiceKey,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreateWebhookEndpointRequest") } },
        },
        responses: {
          "201": created("WebhookEndpointResponse", "Endpoint created"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
        },
      },
      get: {
        tags: ["Webhooks"],
        summary: "List webhook endpoints",
        security: bearerOrServiceKey,
        parameters: [
          { name: "leagueId", in: "query", schema: { type: "string", format: "uuid" }, description: "Filter to one league's endpoints." },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("WebhookEndpointListResponse", "Endpoints"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/webhooks/endpoints/{id}/test": {
      post: {
        tags: ["Webhooks"],
        summary: "Send a test dispatch to a webhook endpoint",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Endpoint id." },
        ],
        responses: {
          "200": ok("WebhookTestDispatchResponse", "Test dispatch sent"),
          "401": errorRef("Unauthorized"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/webhooks/endpoints/{id}/deliveries": {
      get: {
        tags: ["Webhooks"],
        summary: "List deliveries for a webhook endpoint",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Endpoint id." },
          { name: "endpointId", in: "query", schema: { type: "string" }, description: "Filter deliveries by endpoint id." },
          pageParam,
          limitParam,
        ],
        responses: {
          "200": ok("WebhookDeliveryListResponse", "Deliveries"),
          "401": errorRef("Unauthorized"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/webhooks/endpoints/{id}/reactivate": {
      post: {
        tags: ["Webhooks"],
        summary: "Reactivate a disabled webhook endpoint",
        security: bearerOrServiceKey,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Endpoint id." },
        ],
        responses: {
          "200": ok("WebhookEndpointResponse", "Endpoint reactivated"),
          "401": errorRef("Unauthorized"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/webhooks/dead-letter": {
      get: {
        tags: ["Webhooks"],
        summary: "List dead-letter webhook deliveries",
        security: bearerOrServiceKey,
        parameters: [pageParam, limitParam],
        responses: {
          "200": ok("WebhookDeliveryListResponse", "Dead-letter deliveries"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/webhooks/retry": {
      post: {
        tags: ["Webhooks"],
        summary: "Retry a failed webhook delivery",
        security: bearerOrServiceKey,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RetryWebhookDeliveryRequest") } },
        },
        responses: {
          "200": ok("WebhookDeliveryResponse", "Delivery retried"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
          "404": errorRef("NotFound"),
        },
      },
    },
    "/api/v1/sep8/.well-known/stellar.toml": {
      get: {
        tags: ["SEP-8"],
        summary: "Stellar SEP-1 stellar.toml for this anchor",
        responses: {
          "200": { description: "TOML document", content: { "text/plain": { schema: { type: "string" } } } },
          "500": errorRef("InternalError"),
        },
      },
    },
    "/api/v1/sep8/tx_approve": {
      post: {
        tags: ["SEP-8"],
        summary: "SEP-8 transaction authorisation (Stellar sends the transaction here)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("Sep8TxApproveRequest") } },
        },
        responses: {
          "200": ok("Sep8TxApproveResponse", "Authorisation decision"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
        },
      },
      get: {
        tags: ["SEP-8"],
        summary: "SEP-8 transaction authorisation (GET form)",
        parameters: [
          { name: "tx", in: "query", schema: { type: "string" }, description: "Base64-encoded Stellar transaction envelope." },
        ],
        responses: {
          "200": ok("Sep8TxApproveResponse", "Authorisation decision"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/sep8/kyc": {
      post: {
        tags: ["SEP-8"],
        summary: "Submit KYC data",
        security: bearerOrServiceKey,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("SubmitKycRequest") } },
        },
        responses: {
          "200": ok("KycStatusResponse", "KYC submitted"),
          "400": errorRef("BadRequest"),
          "401": errorRef("Unauthorized"),
        },
      },
    },
    "/api/v1/sep8/kyc/status": {
      get: {
        tags: ["SEP-8"],
        summary: "Get KYC status for the signed-in user",
        security: bearerOrServiceKey,
        responses: {
          "200": ok("KycStatusResponse", "KYC status"),
          "401": errorRef("Unauthorized"),
          "404": errorRef("NotFound"),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Access token from POST /auth/login, /auth/refresh or a passkey login, sent as `Authorization: Bearer <token>`.",
      },
      serviceKey: {
        type: "apiKey",
        in: "header",
        name: "X-Service-Key",
        description: "Service API key for automated callers (see src/config/serviceAuth.ts). Accepted anywhere a Bearer token is accepted.",
      },
      internalWebhook: {
        type: "apiKey",
        in: "header",
        name: "X-Fantasy-Signature",
        description:
          "Inter-service webhook signing (see src/middleware/internalWebhookAuth.ts): the request must also carry X-Fantasy-Timestamp (unix seconds, 300s tolerance) and X-Fantasy-Nonce (single-use; reuse returns 409). Documented for completeness — no public v1 REST operation currently enforces this scheme.",
      },
    },
    parameters: {
      Page: {
        name: "page",
        in: "query",
        schema: { type: "integer", minimum: 1, default: 1 },
        description: "Page number, starting at 1.",
      },
      Limit: {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        description: "Items per page (max 100).",
      },
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        schema: { type: "string", pattern: "^[A-Za-z0-9_\\-:.]{1,255}$" },
        description:
          "Exactly-once key for mutations. Replays return the original response with `Idempotent-Replayed: true`; reusing a key for a different request returns 422 and concurrent duplicates return 409.",
      },
    },
    responses: {
      BadRequest: {
        description: "Validation failed",
        content: { "application/json": { schema: ref("ApiError") } },
      },
      Unauthorized: {
        description: "Authentication required or invalid credentials",
        content: { "application/json": { schema: ref("ApiError") } },
      },
      Forbidden: {
        description: "Authenticated but lacking the required permission or role",
        content: { "application/json": { schema: ref("ApiError") } },
      },
      NotFound: {
        description: "Resource not found",
        content: { "application/json": { schema: ref("ApiError") } },
      },
      Conflict: {
        description: "Conflict — e.g. a duplicate resource, or a concurrent duplicate of an idempotent request",
        content: { "application/json": { schema: ref("ApiError") } },
      },
      UnprocessableEntity: {
        description: "Idempotency-Key reused for a different request",
        content: { "application/json": { schema: ref("ApiError") } },
      },
      TooManyRequests: {
        description: "Rate limit exceeded",
        content: { "application/json": { schema: ref("ApiError") } },
      },
      InternalError: {
        description: "Internal server error",
        content: { "application/json": { schema: ref("ApiError") } },
      },
    },
    schemas: {
      ApiSuccess: {
        type: "object",
        required: ["success"],
        properties: {
          success: { type: "boolean", example: true },
          message: { type: "string", example: "Fantasy squad created successfully" },
          data: { type: "object", description: "Response payload; shape depends on the endpoint.", nullable: true },
        },
      },
      ApiError: {
        type: "object",
        required: ["success", "message"],
        properties: {
          success: { type: "boolean", example: false },
          message: { type: "string", example: "Authentication required. Missing Authorization header." },
          errors: { type: "object", description: "Field-level validation errors, when present.", additionalProperties: true },
        },
      },
      ServiceInfo: {
        type: "object",
        properties: {
          name: { type: "string", example: "FantasyXI API" },
          version: { type: "string", example: "0.2.0" },
          status: { type: "string", example: "running" },
          multiTenant: { type: "boolean", example: true },
        },
      },
      HealthResponse: {
        type: "object",
        required: ["success", "message", "timestamp"],
        properties: {
          success: { type: "boolean", example: true },
          message: { type: "string", example: "FantasyXI API is running" },
          timestamp: { type: "string", format: "date-time" },
          tenant: {
            type: "object",
            properties: {
              id: { type: "string" },
              tier: { type: "string" },
              schema: { type: "string" },
            },
          },
        },
      },
      Jwks: {
        type: "object",
        required: ["keys"],
        properties: {
          keys: {
            type: "array",
            items: {
              type: "object",
              required: ["kty", "kid", "use", "alg"],
              properties: {
                kty: { type: "string", example: "OKP" },
                kid: { type: "string" },
                use: { type: "string", example: "sig" },
                alg: { type: "string", example: "EdDSA" },
                crv: { type: "string", example: "Ed25519" },
                x: { type: "string", description: "Base64url-encoded public key." },
              },
            },
          },
        },
      },
      User: {
        type: "object",
        required: ["id", "email", "username", "role"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email", example: "manager@example.com" },
          username: { type: "string", example: "manager" },
          name: { type: "string", nullable: true, example: "Alex Manager" },
          countryCode: { type: "string", nullable: true, example: "NG" },
          role: { type: "string", enum: ["USER", "MODERATOR", "ADMIN", "SERVICE"] },
          referralCode: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      UserResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: ref("User"),
        },
      },
      AuthResult: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            required: ["user", "accessToken", "refreshToken"],
            properties: {
              user: ref("User"),
              accessToken: { type: "string", description: "JWT access token for the Authorization header." },
              refreshToken: { type: "string", description: "Opaque single-use refresh token (login family)." },
              tokenType: { type: "string", example: "Bearer" },
              expiresIn: { type: "integer", description: "Access-token lifetime in seconds." },
              challengeId: { type: "string", description: "Present when a login challenge is required; pass it with the 6-digit code to POST /auth/login/verify." },
            },
          },
        },
      },
      RegisterRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email", example: "manager@example.com" },
          password: { type: "string", format: "password", minLength: 8, description: "At least 8 characters." },
          username: { type: "string", minLength: 3, maxLength: 30, pattern: "^[a-z0-9_-]+$", description: "Optional; generated from the display name or email prefix when omitted." },
          name: { type: "string", example: "Alex Manager" },
          referralCode: { type: "string", description: "Referral code of the inviting user, when used." },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email", example: "manager@example.com" },
          password: { type: "string", format: "password" },
          deviceFingerprint: { type: "string", description: "Client device fingerprint, used for new-device login challenges." },
        },
      },
      VerifyLoginRequest: {
        type: "object",
        required: ["challengeId", "code"],
        properties: {
          challengeId: { type: "string", description: "Challenge id returned by POST /auth/login." },
          code: { type: "string", pattern: "^\\d{6}$", description: "6-digit verification code." },
          deviceFingerprint: { type: "string" },
        },
      },
      RefreshRequest: {
        type: "object",
        required: ["refreshToken"],
        properties: {
          refreshToken: { type: "string", description: "Opaque refresh token issued at login." },
        },
      },
      ReferralCodeResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            required: ["referralCode"],
            properties: { referralCode: { type: "string", example: "ABC123" } },
          },
        },
      },
      GoogleLinkTicketResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            required: ["url"],
            properties: {
              url: { type: "string", format: "uri", description: "Short-lived URL that starts the Google link flow." },
              expiresIn: { type: "integer", description: "Ticket lifetime in seconds." },
            },
          },
        },
      },
      SetPasswordRequest: {
        type: "object",
        required: ["password"],
        properties: {
          password: { type: "string", format: "password", minLength: 8 },
          currentPassword: { type: "string", format: "password", description: "Required when changing an existing password." },
        },
      },
      Session: {
        type: "object",
        required: ["id", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          deviceFingerprint: { type: "string", nullable: true },
          ipAddress: { type: "string", nullable: true },
          userAgent: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          lastActiveAt: { type: "string", format: "date-time", nullable: true },
          current: { type: "boolean", description: "True for the session making this request." },
        },
      },
      SessionListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("Session") },
        },
      },
      PasskeyLoginOptionsRequest: {
        type: "object",
        properties: {
          username: { type: "string", description: "Optional username hint for the passkey ceremony." },
        },
      },
      PasskeyOptionsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "object", description: "WebAuthn options JSON (challenge, rp, allowCredentials) to pass to navigator.credentials." },
        },
      },
      PasskeyLoginVerifyRequest: {
        type: "object",
        required: ["response"],
        properties: {
          response: { type: "object", description: "WebAuthn AuthenticationResponseJSON from navigator.credentials.get()." },
          deviceFingerprint: { type: "string" },
        },
      },
      PasskeyRegisterVerifyRequest: {
        type: "object",
        required: ["response"],
        properties: {
          response: { type: "object", description: "WebAuthn RegistrationResponseJSON from navigator.credentials.create()." },
          name: { type: "string", description: "Display name for the new passkey." },
        },
      },
      PasskeyCredential: {
        type: "object",
        required: ["id", "createdAt"],
        properties: {
          id: { type: "string", description: "Credential id (base64url)." },
          name: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          lastUsedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      PasskeyCredentialListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("PasskeyCredential") },
        },
      },
      PaginationMeta: {
        type: "object",
        properties: {
          page: { type: "integer", example: 1 },
          limit: { type: "integer", example: 50 },
          total: { type: "integer", example: 120 },
          totalPages: { type: "integer", example: 3 },
        },
      },
      Player: {
        type: "object",
        required: ["id", "fplId", "firstName", "lastName", "displayName", "position", "teamId", "price", "totalPoints"],
        properties: {
          id: { type: "integer", example: 123 },
          fplId: { type: "integer", example: 123 },
          firstName: { type: "string", example: "Mohamed" },
          lastName: { type: "string", example: "Salah" },
          displayName: { type: "string", example: "M. Salah" },
          position: { type: "string", enum: ["GKP", "DEF", "MID", "FWD"] },
          teamId: { type: "integer", example: 1 },
          price: { type: "number", example: 12.5, description: "Price in millions." },
          totalPoints: { type: "integer", example: 187 },
          minutesPlayed: { type: "integer", example: 2700 },
          goalsScored: { type: "integer", example: 22 },
          assists: { type: "integer", example: 11 },
          cleanSheets: { type: "integer", example: 9 },
          form: { type: "number", nullable: true, example: 7.2 },
          status: { type: "string", nullable: true, example: "a", description: "FPL availability code: a available, d doubtful, i injured, s suspended, u unavailable." },
          news: { type: "string", nullable: true },
          chanceOfPlayingNextRound: { type: "integer", nullable: true, example: 100 },
          selectedByPercent: { type: "number", nullable: true, example: 42.1 },
          photoUrl: { type: "string", nullable: true },
          isAvailable: { type: "boolean", example: true },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      PlayerResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("Player") },
      },
      PlayerListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("Player") },
          meta: ref("PaginationMeta"),
        },
      },
      PlayerOwnershipStatsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              required: ["playerId", "ownershipPercent"],
              properties: {
                playerId: { type: "integer" },
                displayName: { type: "string" },
                ownershipPercent: { type: "number" },
                squadCount: { type: "integer" },
              },
            },
          },
        },
      },
      BatchPlayerStatsRequest: {
        type: "object",
        required: ["playerIds"],
        properties: {
          playerIds: { type: "array", items: { type: "integer" }, description: "Player ids to fetch stats for." },
          gameweekId: { type: "integer", description: "Gameweek to scope stats to; omit for totals." },
        },
      },
      BatchPlayerStatsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              required: ["playerId"],
              properties: {
                playerId: { type: "integer" },
                totalPoints: { type: "integer" },
                goalsScored: { type: "integer" },
                assists: { type: "integer" },
                minutesPlayed: { type: "integer" },
              },
            },
          },
        },
      },
      PlayerAnalyticsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            description: "Expected points (xP) and fixture difficulty for the player over the requested horizon.",
            properties: {
              playerId: { type: "integer" },
              expectedPoints: { type: "number" },
              fixtureDifficulty: { type: "number" },
              horizon: { type: "integer" },
            },
          },
        },
      },
      Team: {
        type: "object",
        required: ["id", "fplId", "name", "shortName"],
        properties: {
          id: { type: "integer", example: 1 },
          fplId: { type: "integer", example: 1 },
          name: { type: "string", example: "Arsenal" },
          shortName: { type: "string", example: "ARS" },
          logoUrl: { type: "string", nullable: true },
          strength: { type: "integer", nullable: true },
          strengthOverallHome: { type: "integer", nullable: true },
          strengthOverallAway: { type: "integer", nullable: true },
          strengthAttackHome: { type: "integer", nullable: true },
          strengthAttackAway: { type: "integer", nullable: true },
          strengthDefenceHome: { type: "integer", nullable: true },
          strengthDefenceAway: { type: "integer", nullable: true },
        },
      },
      TeamResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("Team") },
      },
      TeamListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("Team") },
        },
      },
      Gameweek: {
        type: "object",
        required: ["id", "fplId", "name", "deadline", "isCurrent", "isFinished", "isLocked", "season"],
        properties: {
          id: { type: "integer", example: 12 },
          fplId: { type: "integer", example: 12 },
          name: { type: "string", example: "Gameweek 12" },
          deadline: { type: "string", format: "date-time" },
          isCurrent: { type: "boolean", example: true },
          isFinished: { type: "boolean", example: false },
          isLocked: { type: "boolean", example: false },
          settledAt: { type: "string", format: "date-time", nullable: true },
          season: { type: "string", example: "2026/27" },
        },
      },
      GameweekResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("Gameweek") },
      },
      GameweekListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("Gameweek") },
        },
      },
      GameweekHistoryResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                gameweekId: { type: "integer" },
                gameweekName: { type: "string" },
                points: { type: "integer" },
                rank: { type: "integer", nullable: true },
              },
            },
          },
        },
      },
      Fixture: {
        type: "object",
        required: ["id", "fplId", "homeTeamId", "awayTeamId", "started", "finished", "minutes"],
        properties: {
          id: { type: "integer", example: 101 },
          fplId: { type: "integer", example: 101 },
          gameweekId: { type: "integer", nullable: true },
          homeTeamId: { type: "integer", example: 1 },
          awayTeamId: { type: "integer", example: 2 },
          kickoffTime: { type: "string", format: "date-time", nullable: true },
          started: { type: "boolean", example: false },
          finished: { type: "boolean", example: false },
          homeScore: { type: "integer", nullable: true },
          awayScore: { type: "integer", nullable: true },
          minutes: { type: "integer", example: 0 },
        },
      },
      FixtureListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("Fixture") },
        },
      },
      SquadPlayerInput: {
        type: "object",
        required: ["playerId", "positionOrder"],
        properties: {
          playerId: { type: "integer", example: 123 },
          isCaptain: { type: "boolean", default: false },
          isViceCaptain: { type: "boolean", default: false },
          isStarter: { type: "boolean", default: true },
          positionOrder: { type: "integer", example: 1, description: "Order within the position group (1-based)." },
        },
      },
      CreateSquadRequest: {
        type: "object",
        required: ["name", "players"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100, example: "Thunder Strikers" },
          players: {
            type: "array",
            minItems: 15,
            maxItems: 15,
            items: ref("SquadPlayerInput"),
            description: "Exactly 15 players: 2 GKP, 5 DEF, 5 MID, 3 FWD, within the 100.0 budget.",
          },
        },
      },
      UpdateSquadRequest: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          players: {
            type: "array",
            minItems: 15,
            maxItems: 15,
            items: ref("SquadPlayerInput"),
            description: "Full replacement selection of 15 players (transfers).",
          },
        },
      },
      SquadPlayer: {
        type: "object",
        required: ["id", "squadId", "playerId", "isCaptain", "isViceCaptain", "isStarter", "positionOrder", "purchasePrice"],
        properties: {
          id: { type: "integer" },
          squadId: { type: "string", format: "uuid" },
          playerId: { type: "integer" },
          isCaptain: { type: "boolean" },
          isViceCaptain: { type: "boolean" },
          isStarter: { type: "boolean" },
          positionOrder: { type: "integer" },
          purchasePrice: { type: "number", example: 12.5 },
          player: ref("Player"),
        },
      },
      Squad: {
        type: "object",
        required: ["id", "userId", "name", "budgetRemaining", "totalPoints", "freeTransfers"],
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          name: { type: "string", example: "Thunder Strikers" },
          budgetRemaining: { type: "number", example: 2.5 },
          totalPoints: { type: "integer", example: 512 },
          freeTransfers: { type: "integer", example: 1 },
          freeTransfersGameweekId: { type: "integer", nullable: true },
          players: { type: "array", items: ref("SquadPlayer") },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      SquadResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          message: { type: "string" },
          data: ref("Squad"),
        },
      },
      SquadListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("Squad") },
        },
      },
      SquadValuation: {
        type: "object",
        required: ["squadId", "bank", "squadValue", "teamValue"],
        properties: {
          squadId: { type: "string", format: "uuid" },
          bank: { type: "number", example: 2.5, description: "Unspent budget." },
          squadValue: { type: "number", example: 97.5, description: "Current value of the 15 selected players." },
          teamValue: { type: "number", example: 100.0, description: "Bank plus squad value." },
        },
      },
      SquadValuationResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("SquadValuation") },
      },
      ActivateChipRequest: {
        type: "object",
        required: ["chipType", "gameweekId"],
        properties: {
          chipType: { type: "string", enum: ["TRIPLE_CAPTAIN", "BENCH_BOOST", "FREE_HIT", "WILDCARD"] },
          gameweekId: { type: "integer", example: 12 },
        },
      },
      SquadScoreResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              squadId: { type: "string", format: "uuid" },
              gameweekId: { type: "integer" },
              points: { type: "integer" },
            },
          },
        },
      },
      League: {
        type: "object",
        required: ["id", "name", "creatorId", "inviteCode", "maxMembers", "minMembers", "currentMembers", "entryFee", "prizePool", "status", "scoringType", "isPrivate", "startGameweekId", "endGameweekId"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "Lagos Premier League" },
          description: { type: "string", nullable: true },
          creatorId: { type: "string", format: "uuid" },
          inviteCode: { type: "string", example: "AB12CD34", description: "Only returned to the creator." },
          maxMembers: { type: "integer", example: 20 },
          minMembers: { type: "integer", example: 2 },
          currentMembers: { type: "integer", example: 7 },
          entryFee: { type: "number", example: 10.0, description: "Entry fee in USDC." },
          prizePool: { type: "number", example: 70.0 },
          status: { type: "string", enum: ["UPCOMING", "ACTIVE", "COMPLETED", "CANCELLED"] },
          scoringType: { type: "string", enum: ["CLASSIC", "HEAD_TO_HEAD"] },
          scoringConfig: { type: "object", nullable: true, description: "Custom scoring rule set for the league." },
          payoutPreset: { type: "string", example: "standard" },
          payoutSplitsBps: { type: "array", items: { type: "integer" }, description: "Prize splits in basis points." },
          isPrivate: { type: "boolean", example: false },
          minBuyIn: { type: "number", nullable: true, description: "Private high-roller leagues: minimum stake for the ZK range proof." },
          maxBuyIn: { type: "number", nullable: true },
          startGameweekId: { type: "integer", example: 1 },
          endGameweekId: { type: "integer", example: 38 },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      LeagueResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          message: { type: "string" },
          data: ref("League"),
        },
      },
      LeagueListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("League") },
          meta: ref("PaginationMeta"),
        },
      },
      CreateLeagueRequest: {
        type: "object",
        required: ["name", "startGameweekId", "endGameweekId"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100, example: "Lagos Premier League" },
          description: { type: "string" },
          maxMembers: { type: "integer", minimum: 2, default: 20 },
          minMembers: { type: "integer", minimum: 2, default: 2 },
          entryFee: { type: "number", minimum: 0, default: 0, description: "Entry fee in USDC." },
          scoringType: { type: "string", enum: ["CLASSIC", "HEAD_TO_HEAD"], default: "CLASSIC" },
          scoringConfig: { type: "object", description: "Custom scoring rule set." },
          payoutPreset: { type: "string", default: "standard" },
          payoutSplitsBps: { type: "array", items: { type: "integer", minimum: 0, maximum: 10000 } },
          isPrivate: { type: "boolean", default: false },
          minBuyIn: { type: "number", minimum: 0, description: "Private high-roller leagues only." },
          maxBuyIn: { type: "number", minimum: 0 },
          startGameweekId: { type: "integer", example: 1 },
          endGameweekId: { type: "integer", example: 38 },
        },
      },
      JoinLeagueRequest: {
        type: "object",
        required: ["squadId"],
        properties: {
          squadId: { type: "string", format: "uuid", description: "Squad entering the league." },
        },
      },
      LeagueMember: {
        type: "object",
        required: ["id", "leagueId", "userId", "squadId", "status", "paymentStatus", "joinedAt", "hasPaid", "totalPoints"],
        properties: {
          id: { type: "string", format: "uuid" },
          leagueId: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          squadId: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["PENDING", "ACTIVE", "CANCELLED", "REFUNDED"] },
          paymentStatus: { type: "string", enum: ["PENDING", "PAYMENT_INITIATED", "PAYMENT_SUBMITTED", "PAYMENT_CONFIRMED", "PAYMENT_FAILED", "REFUND_PENDING", "REFUNDED"] },
          stellarAddress: { type: "string", nullable: true },
          joinedAt: { type: "string", format: "date-time" },
          hasPaid: { type: "boolean" },
          rank: { type: "integer", nullable: true },
          totalPoints: { type: "integer", example: 512 },
          matchesWon: { type: "integer", example: 5 },
          matchesDrawn: { type: "integer", example: 2 },
          matchesLost: { type: "integer", example: 3 },
          pointsFor: { type: "integer" },
          pointsAgainst: { type: "integer" },
          h2hPoints: { type: "integer" },
        },
      },
      LeagueMemberResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("LeagueMember") },
      },
      LeagueMemberListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("LeagueMember") },
          meta: ref("PaginationMeta"),
        },
      },
      LeagueStandingsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              required: ["rank", "squadId", "totalPoints"],
              properties: {
                rank: { type: "integer", example: 1 },
                squadId: { type: "string", format: "uuid" },
                squadName: { type: "string" },
                username: { type: "string" },
                totalPoints: { type: "integer", example: 512 },
                gameweekPoints: { type: "integer" },
              },
            },
          },
          meta: ref("PaginationMeta"),
        },
      },
      H2HStandingsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              required: ["rank", "squadId"],
              properties: {
                rank: { type: "integer", example: 1 },
                squadId: { type: "string", format: "uuid" },
                squadName: { type: "string" },
                matchesWon: { type: "integer" },
                matchesDrawn: { type: "integer" },
                matchesLost: { type: "integer" },
                pointsFor: { type: "integer" },
                pointsAgainst: { type: "integer" },
                h2hPoints: { type: "integer" },
              },
            },
          },
        },
      },
      CreateLeagueInvitationRequest: {
        type: "object",
        properties: {
          expiresInHours: { type: "number", minimum: 1, description: "Invitation lifetime in hours." },
          maxUses: { type: "integer", minimum: 1, default: 1, description: "How many times the invitation can be redeemed." },
        },
      },
      LeagueInvitation: {
        type: "object",
        required: ["id", "leagueId", "createdById", "expiresAt", "maxUses", "usesCount"],
        properties: {
          id: { type: "string", format: "uuid" },
          leagueId: { type: "string", format: "uuid" },
          token: { type: "string", description: "Single-use invitation token (only returned at creation)." },
          createdById: { type: "string", format: "uuid" },
          expiresAt: { type: "string", format: "date-time" },
          maxUses: { type: "integer", example: 1 },
          usesCount: { type: "integer", example: 0 },
          usedAt: { type: "string", format: "date-time", nullable: true },
          usedById: { type: "string", format: "uuid", nullable: true },
          revokedAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      LeagueInvitationResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("LeagueInvitation") },
      },
      LeagueInvitationListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("LeagueInvitation") },
          meta: ref("PaginationMeta"),
        },
      },
      LeagueInvitationPreviewResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            required: ["league"],
            properties: {
              league: ref("League"),
              expiresAt: { type: "string", format: "date-time" },
              maxUses: { type: "integer" },
              usesCount: { type: "integer" },
            },
          },
        },
      },
      ChatMessage: {
        type: "object",
        required: ["id", "leagueId", "userId", "body", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          leagueId: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          username: { type: "string" },
          body: { type: "string", maxLength: 500, example: "Good luck this gameweek!" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      PostChatMessageRequest: {
        type: "object",
        required: ["body"],
        properties: {
          body: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
      ChatMessageResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("ChatMessage") },
      },
      ChatMessageListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("ChatMessage") },
        },
      },
      SwissInitRequest: {
        type: "object",
        required: ["participants", "totalRounds"],
        properties: {
          participants: { type: "array", items: { type: "string", format: "uuid" }, description: "Squad ids in the tournament." },
          totalRounds: { type: "integer", minimum: 1 },
        },
      },
      SwissTournamentResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              leagueId: { type: "string", format: "uuid" },
              totalRounds: { type: "integer" },
              currentRound: { type: "integer" },
            },
          },
        },
      },
      SwissStandingsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                rank: { type: "integer" },
                squadId: { type: "string", format: "uuid" },
                squadName: { type: "string" },
                wins: { type: "integer" },
                draws: { type: "integer" },
                losses: { type: "integer" },
                points: { type: "integer" },
              },
            },
          },
        },
      },
      SwissRoundResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              leagueId: { type: "string", format: "uuid" },
              round: { type: "integer" },
              fixtures: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
      SwissAdvanceRequest: {
        type: "object",
        required: ["gameweekId"],
        properties: {
          gameweekId: { type: "integer", description: "Gameweek whose results seed the next round's pairings." },
        },
      },
      SwissResolveRequest: {
        type: "object",
        required: ["results"],
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              required: ["homeSquadId", "awaySquadId", "homeScore", "awayScore"],
              properties: {
                homeSquadId: { type: "string", format: "uuid" },
                awaySquadId: { type: "string", format: "uuid" },
                homeScore: { type: "integer" },
                awayScore: { type: "integer" },
              },
            },
          },
        },
      },
      LiveTimelineResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              gameweekId: { type: "integer" },
              events: { type: "array", items: { type: "object" } },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      LiveLeaderboardResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                rank: { type: "integer" },
                squadId: { type: "string", format: "uuid" },
                squadName: { type: "string" },
                livePoints: { type: "integer" },
                totalPoints: { type: "integer" },
              },
            },
          },
        },
      },
      LeaderboardEntry: {
        type: "object",
        required: ["rank", "squadId", "totalPoints"],
        properties: {
          rank: { type: "integer", example: 1 },
          squadId: { type: "string", format: "uuid" },
          squadName: { type: "string", example: "Thunder Strikers" },
          username: { type: "string", example: "manager" },
          totalPoints: { type: "integer", example: 512 },
          gameweekPoints: { type: "integer" },
        },
      },
      LeaderboardResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("LeaderboardEntry") },
          meta: ref("PaginationMeta"),
          viewerPosition: {
            type: "object",
            nullable: true,
            description: "Signed-in viewer's own entry, when authenticated.",
            properties: {
              rank: { type: "integer" },
              squadId: { type: "string", format: "uuid" },
              totalPoints: { type: "integer" },
            },
          },
        },
      },
      MatchmakingCandidate: {
        type: "object",
        properties: {
          userId: { type: "string", format: "uuid" },
          username: { type: "string" },
          rating: { type: "number" },
          ratingDifference: { type: "number" },
        },
      },
      MatchmakingCandidatesResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("MatchmakingCandidate") },
          meta: {
            type: "object",
            properties: { tolerance: { type: "integer", example: 200 } },
          },
        },
      },
      JoinMatchmakingRequest: {
        type: "object",
        properties: {
          squadId: { type: "string", format: "uuid", description: "Squad to queue for matchmaking; defaults to the user's first squad." },
          tolerance: { type: "integer", minimum: 100, maximum: 1000, default: 200 },
        },
      },
      MatchmakingQueueResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["QUEUED", "MATCHED"] },
              queuePosition: { type: "integer" },
              matchedUserId: { type: "string", format: "uuid", nullable: true },
            },
          },
        },
      },
      PerformanceResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            description: "Per-gameweek, cumulative and rolling points benchmarked against the platform average.",
            properties: {
              squadId: { type: "string", format: "uuid" },
              perGameweek: { type: "array", items: { type: "object" } },
              cumulative: { type: "array", items: { type: "object" } },
              rollingAverage: { type: "array", items: { type: "object" } },
              platformAverage: { type: "number" },
            },
          },
        },
      },
      PaymentRequirement: {
        type: "object",
        required: ["leagueId", "leagueName", "entryFee", "assetCode", "destinationAddress", "memo", "paymentStatus"],
        properties: {
          leagueId: { type: "string", format: "uuid" },
          leagueName: { type: "string" },
          entryFee: { type: "number", example: 10.0, description: "Entry fee in USDC." },
          assetCode: { type: "string", example: "USDC" },
          assetIssuer: { type: "string", description: "Stellar asset issuer (USDC)." },
          destinationAddress: { type: "string", description: "Escrow contract or platform treasury Stellar address." },
          escrowContractId: { type: "string" },
          memo: { type: "string", example: "LEAGUE:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:USER:ffffffff-0000-1111-2222-333333333333", description: "Deterministic payment identifier." },
          paymentStatus: { type: "string", enum: ["PENDING", "PAYMENT_INITIATED", "PAYMENT_SUBMITTED", "PAYMENT_CONFIRMED", "PAYMENT_FAILED", "REFUND_PENDING", "REFUNDED"] },
        },
      },
      PaymentRequirementResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("PaymentRequirement") },
      },
      SubmitPaymentRequest: {
        type: "object",
        required: ["stellarTxHash", "stellarAddress"],
        properties: {
          stellarTxHash: { type: "string", description: "Stellar transaction hash of the entry-fee payment." },
          stellarAddress: { type: "string", description: "Payer's Stellar address." },
          squadId: { type: "string", format: "uuid" },
          leagueId: { type: "string", format: "uuid" },
        },
      },
      PaymentSubmissionResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              txHash: { type: "string" },
              status: { type: "string", enum: ["PENDING", "SUBMITTED", "CONFIRMED", "FAILED"] },
            },
          },
        },
      },
      VerifyPaymentRequest: {
        type: "object",
        required: ["stellarTxHash"],
        properties: {
          stellarTxHash: { type: "string", description: "Stellar transaction hash to verify on Horizon." },
        },
      },
      PaymentVerificationResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            required: ["success", "txHash"],
            properties: {
              retryable: { type: "boolean", description: "Verification unavailable; do not turn a transport failure into a payment failure." },
              success: { type: "boolean", example: true },
              txHash: { type: "string" },
              ledgerSeq: { type: "integer" },
              amount: { type: "number" },
              assetCode: { type: "string", example: "USDC" },
              senderAddress: { type: "string" },
              destinationAddress: { type: "string" },
              confirmedAt: { type: "string", format: "date-time" },
              error: { type: "string" },
              notFound: { type: "boolean", description: "Horizon has no transaction with this hash." },
            },
          },
        },
      },
      SimulateDepositRequest: {
        type: "object",
        required: ["leagueId", "squadId"],
        properties: {
          leagueId: { type: "string", format: "uuid" },
          squadId: { type: "string", format: "uuid" },
          publicKey: { type: "string", description: "Payer's Stellar public key." },
        },
      },
      SimulateDepositResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              entryFee: { type: "number" },
              platformFee: { type: "number" },
              estimatedFootprint: { type: "object", description: "Soroban footprint / resource estimate." },
            },
          },
        },
      },
      SettlementWinner: {
        type: "object",
        required: ["rank", "userId", "username", "stellarAddress", "squadName", "totalPoints", "prizeAmount"],
        properties: {
          rank: { type: "integer", example: 1 },
          userId: { type: "string", format: "uuid" },
          username: { type: "string" },
          stellarAddress: { type: "string" },
          squadName: { type: "string" },
          totalPoints: { type: "integer" },
          prizeAmount: { type: "number", description: "Prize in USDC." },
        },
      },
      SettlementPlan: {
        type: "object",
        required: ["leagueId", "leagueName", "status", "totalParticipants", "entryFee"],
        properties: {
          leagueId: { type: "string", format: "uuid" },
          leagueName: { type: "string" },
          status: { type: "string", enum: ["UPCOMING", "ACTIVE", "COMPLETED", "CANCELLED"] },
          totalParticipants: { type: "integer" },
          entryFee: { type: "number" },
          prizePool: { type: "number" },
          winners: { type: "array", items: ref("SettlementWinner") },
        },
      },
      SettlementPlanResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("SettlementPlan") },
      },
      ExecuteSettlementRequest: {
        type: "object",
        properties: {
          winners: { type: "array", items: ref("SettlementWinner"), description: "Explicit winners; omit to settle from the standings." },
          platformTreasury: { type: "string", description: "Stellar address receiving the platform fee." },
          platformFeeStroops: { type: "string", description: "Platform fee in stroops." },
          notes: { type: "string" },
        },
      },
      SettlementResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              leagueId: { type: "string", format: "uuid" },
              txHash: { type: "string" },
              status: { type: "string", enum: ["PENDING", "SUBMITTED", "CONFIRMED", "FAILED"] },
            },
          },
        },
      },
      MerkleSettleRequest: {
        type: "object",
        required: ["participants", "notes"],
        properties: {
          participants: { type: "array", items: ref("SettlementWinner") },
          notes: { type: "string" },
        },
      },
      AffiliateDashboardResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              referralCode: { type: "string" },
              referrals: { type: "integer" },
              earnings: { type: "number" },
            },
          },
        },
      },
      ReconcileDepositRequest: {
        type: "object",
        required: ["stellarTxHash"],
        properties: {
          stellarTxHash: { type: "string" },
          squadId: { type: "string", format: "uuid" },
          leagueId: { type: "string", format: "uuid" },
        },
      },
      ReconcileDepositResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              found: { type: "boolean" },
              paymentStatus: { type: "string" },
              txHash: { type: "string" },
            },
          },
        },
      },
      RefundClaimChallengeResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            required: ["challenge"],
            properties: {
              challenge: { type: "string", description: "Challenge string to sign with the depositing Stellar key." },
              txHash: { type: "string" },
            },
          },
        },
      },
      DepositException: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          txHash: { type: "string" },
          reason: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      DepositExceptionListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("DepositException") },
        },
      },
      SubmitRefundClaimRequest: {
        type: "object",
        required: ["txHash", "publicKey", "signature"],
        properties: {
          txHash: { type: "string", description: "Stellar transaction hash of the deposit." },
          publicKey: { type: "string", description: "Stellar public key that made the deposit." },
          signature: { type: "string", description: "Signature over the refund-claim challenge." },
        },
      },
      RefundClaimResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              claimId: { type: "string", format: "uuid" },
              status: { type: "string" },
              txHash: { type: "string" },
            },
          },
        },
      },
      LeagueReconciliationResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            description: "League financial reconciliation report (PostgreSQL vs Stellar).",
            properties: {
              leagueId: { type: "string", format: "uuid" },
              matched: { type: "integer" },
              discrepancies: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
      StorageRentStatusResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              currentLedger: { type: "integer" },
              entries: { type: "array", items: { type: "object" } },
              rentReserves: { type: "array", items: { type: "object" } },
              thresholds: { type: "object" },
            },
          },
        },
      },
      StorageRentRecoverRequest: {
        type: "object",
        properties: {
          contractIds: { type: "array", items: { type: "string" }, description: "Contracts to recover; defaults to the Stellar escrow contract." },
        },
      },
      StorageRentRecoverResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "object", properties: { recovered: { type: "integer" }, failed: { type: "integer" } } },
        },
      },
      FileDisputeRequest: {
        type: "object",
        required: ["claimantAddress", "reason"],
        properties: {
          claimantAddress: { type: "string", description: "Stellar address of the claimant." },
          reason: { type: "string" },
          evidenceUrl: { type: "string", format: "uri" },
          leagueId: { type: "string", format: "uuid" },
          autoFreeze: { type: "boolean", default: true, description: "Freeze the escrow while the dispute is open." },
        },
      },
      Dispute: {
        type: "object",
        required: ["id", "leagueId", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          leagueId: { type: "string", format: "uuid" },
          claimantAddress: { type: "string" },
          reason: { type: "string" },
          status: { type: "string", enum: ["OPEN", "EVIDENCE", "RESOLVED_PAYOUT", "RESOLVED_REFUND", "REJECTED"] },
          evidenceUrl: { type: "string", format: "uri", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      DisputeResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("Dispute") },
      },
      DisputeListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("Dispute") },
          meta: ref("PaginationMeta"),
        },
      },
      AddDisputeEvidenceRequest: {
        type: "object",
        required: ["submittedBy", "description"],
        properties: {
          submittedBy: { type: "string", format: "uuid" },
          description: { type: "string" },
          evidenceUrl: { type: "string", format: "uri" },
        },
      },
      ResolveDisputeRequest: {
        type: "object",
        properties: {
          notes: { type: "string" },
        },
      },
      ProofOfReserveSnapshot: {
        type: "object",
        required: ["runId", "generatedAt", "status", "depositCount", "ledgerRoot", "onChainRoot", "liabilitiesStroops", "reserveStroops", "discrepancyCount", "durationMs"],
        properties: {
          runId: { type: "string", format: "uuid" },
          generatedAt: { type: "string", format: "date-time" },
          status: { type: "string", enum: ["VERIFIED", "DISCREPANCY"] },
          depositCount: { type: "integer", example: 128 },
          ledgerRoot: { type: "string", description: "Merkle root of ledger liabilities." },
          onChainRoot: { type: "string", description: "Merkle root of on-chain reserves." },
          liabilitiesStroops: { type: "string", example: "1000000000", description: "Total liabilities in stroops (1 XLM = 10^7 stroops)." },
          reserveStroops: { type: "string", example: "1000000000" },
          discrepancyCount: { type: "integer", example: 0 },
          durationMs: { type: "integer" },
        },
      },
      ProofOfReserveResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("ProofOfReserveSnapshot") },
      },
      Tenant: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          displayName: { type: "string" },
          tier: { type: "string", enum: ["ENTERPRISE", "SPONSORED"] },
          schemaName: { type: "string" },
        },
      },
      TenantListResponse: {
        type: "object",
        required: ["success", "data", "count"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("Tenant") },
          count: { type: "integer" },
        },
      },
      TenantResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          message: { type: "string" },
          data: ref("Tenant"),
        },
      },
      CreateTenantRequest: {
        type: "object",
        required: ["tier", "displayName"],
        properties: {
          tier: { type: "string", enum: ["ENTERPRISE", "SPONSORED"] },
          displayName: { type: "string" },
        },
      },
      TenantStatsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "object", description: "Tenant boundary violation statistics for the last 24 hours." },
        },
      },
      FailedPayout: {
        type: "object",
        required: ["id", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          leagueId: { type: "string", format: "uuid", nullable: true },
          userId: { type: "string", format: "uuid", nullable: true },
          amount: { type: "number" },
          status: { type: "string", enum: ["PENDING", "RETRYING", "RESOLVED", "DISCARDED"] },
          error: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      FailedPayoutResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("FailedPayout") },
      },
      FailedPayoutListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("FailedPayout") },
          meta: ref("PaginationMeta"),
        },
      },
      FinancialAuditLogEntry: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          action: { type: "string", description: "Append-only audit action (see FinancialAuditAction)." },
          userId: { type: "string", format: "uuid", nullable: true },
          leagueId: { type: "string", format: "uuid", nullable: true },
          amount: { type: "number" },
          hash: { type: "string", description: "SHA-256 chain hash of this entry." },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      FinancialAuditLogResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("FinancialAuditLogEntry") },
          meta: ref("PaginationMeta"),
        },
      },
      AuditVerifyResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            required: ["valid"],
            properties: {
              valid: { type: "boolean" },
              checkedEntries: { type: "integer" },
              anomalies: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
      LedgerReconciliationResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "object", description: "PostgreSQL vs Stellar reconciliation report." },
        },
      },
      CoordinatedTransaction: {
        type: "object",
        properties: {
          txHash: { type: "string" },
          status: { type: "string", enum: ["PENDING", "SUCCESS", "FAILED", "DROPPED"] },
          attempts: { type: "integer" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CoordinatedTransactionResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("CoordinatedTransaction") },
      },
      RetroactiveAdjustmentRequest: {
        type: "object",
        required: ["adjustments"],
        properties: {
          adjustments: {
            type: "array",
            items: {
              type: "object",
              required: ["playerId", "pointsDelta"],
              properties: {
                playerId: { type: "integer" },
                pointsDelta: { type: "integer", description: "Points to add (negative to subtract)." },
                reason: { type: "string" },
              },
            },
          },
        },
      },
      RetroactiveAdjustmentResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              gameweekId: { type: "integer" },
              adjustedSquads: { type: "integer" },
            },
          },
        },
      },
      SecurityAnomaliesResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", example: "failed-login-spike" },
                email: { type: "string", format: "email" },
                count: { type: "integer" },
                firstSeenAt: { type: "string", format: "date-time" },
                lastSeenAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      SybilReportResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              leagueId: { type: "string", format: "uuid" },
              clusters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    userIds: { type: "array", items: { type: "string", format: "uuid" } },
                    riskScore: { type: "number" },
                    evidence: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
      H2HAnomaliesResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: { type: "object" } },
        },
      },
      RecalculateStandingsRequest: {
        type: "object",
        required: ["gameweekId"],
        properties: {
          gameweekId: { type: "integer", description: "Gameweek to recalculate standings for." },
        },
      },
      RecalculateStandingsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              leaguesRecalculated: { type: "integer" },
              gameweekId: { type: "integer" },
            },
          },
        },
      },
      TierGroup: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          season: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      TierGroupResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("TierGroup") },
      },
      CreateTierGroupRequest: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          season: { type: "string", example: "2026/27" },
        },
      },
      Tier: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          groupId: { type: "string", format: "uuid" },
          name: { type: "string", example: "Premier" },
          level: { type: "integer", example: 1 },
        },
      },
      TierResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("Tier") },
      },
      CreateTierRequest: {
        type: "object",
        required: ["name", "level"],
        properties: {
          name: { type: "string", example: "Premier" },
          level: { type: "integer", minimum: 1 },
        },
      },
      SeasonEndTransitionsRequest: {
        type: "object",
        required: ["season"],
        properties: {
          season: { type: "string", example: "2026/27" },
        },
      },
      SeasonEndTransitionsResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              promoted: { type: "integer" },
              relegated: { type: "integer" },
              stayed: { type: "integer" },
            },
          },
        },
      },
      LedgerAuditReport: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          runId: { type: "string", format: "uuid" },
          status: { type: "string" },
          findings: { type: "integer" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      LedgerAuditReportListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("LedgerAuditReport") },
          meta: ref("PaginationMeta"),
        },
      },
      SyncResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              synced: { type: "integer" },
              skipped: { type: "integer" },
              errors: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      CreateWebhookEndpointRequest: {
        type: "object",
        required: ["url", "events"],
        properties: {
          url: { type: "string", format: "uri", example: "https://example.com/fantasyxi-webhooks" },
          events: { type: "array", minItems: 1, items: { type: "string" }, example: ["league.settled", "payment.confirmed"] },
          leagueId: { type: "string", format: "uuid", description: "Scope the endpoint to one league; omit for all leagues." },
        },
      },
      WebhookEndpoint: {
        type: "object",
        required: ["id", "url", "events", "isActive"],
        properties: {
          id: { type: "string", format: "uuid" },
          url: { type: "string", format: "uri" },
          events: { type: "array", items: { type: "string" } },
          leagueId: { type: "string", format: "uuid", nullable: true },
          isActive: { type: "boolean", example: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      WebhookEndpointResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("WebhookEndpoint") },
      },
      WebhookEndpointListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("WebhookEndpoint") },
          meta: ref("PaginationMeta"),
        },
      },
      WebhookDelivery: {
        type: "object",
        required: ["id", "endpointId", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          endpointId: { type: "string", format: "uuid" },
          event: { type: "string" },
          status: { type: "string", enum: ["PENDING", "DELIVERED", "FAILED", "DEAD_LETTER"] },
          attempts: { type: "integer" },
          lastError: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      WebhookDeliveryResponse: {
        type: "object",
        required: ["success", "data"],
        properties: { success: { type: "boolean", example: true }, data: ref("WebhookDelivery") },
      },
      WebhookDeliveryListResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "array", items: ref("WebhookDelivery") },
          meta: ref("PaginationMeta"),
        },
      },
      WebhookTestDispatchResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              deliveryId: { type: "string", format: "uuid" },
              status: { type: "string" },
            },
          },
        },
      },
      RetryWebhookDeliveryRequest: {
        type: "object",
        required: ["deliveryId"],
        properties: {
          deliveryId: { type: "string", format: "uuid" },
        },
      },
      Sep8TxApproveRequest: {
        type: "object",
        required: ["tx"],
        properties: {
          tx: { type: "string", description: "Base64-encoded Stellar transaction envelope." },
        },
      },
      Sep8TxApproveResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["approved", "revised", "rejected"], description: "SEP-8 authorisation decision." },
              tx: { type: "string", description: "Revised transaction envelope, when status is revised." },
              error: { type: "string" },
            },
          },
        },
      },
      SubmitKycRequest: {
        type: "object",
        required: ["firstName", "lastName"],
        properties: {
          firstName: { type: "string" },
          lastName: { type: "string" },
          dateOfBirth: { type: "string", format: "date" },
          address: { type: "string" },
          countryCode: { type: "string" },
          documentType: { type: "string", enum: ["PASSPORT", "NATIONAL_ID", "DRIVERS_LICENSE"] },
        },
      },
      KycStatusResponse: {
        type: "object",
        required: ["success", "data"],
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            required: ["status"],
            properties: {
              status: { type: "string", enum: ["NOT_STARTED", "PENDING", "APPROVED", "REJECTED"] },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
  },
};

export default openApiSpec;
