/**
 * WebAuthn / passkey relying-party configuration (issue #273).
 *
 * WEBAUTHN_RP_ID      Relying party ID: the registrable domain passkeys are bound to
 *                     (default: hostname of FRONTEND_URL, e.g. "fantasyxi.app")
 * WEBAUTHN_RP_NAME    Name shown by the authenticator (default "FantasyXI")
 * WEBAUTHN_ORIGINS    Comma-separated origins allowed to run ceremonies
 *                     (default: FRONTEND_URL)
 * WEBAUTHN_CHALLENGE_TTL_SECONDS  Lifetime of a ceremony challenge (default 300)
 */

/** Purpose claim of the ticket that lets a password login finish with a passkey */
export const PASSKEY_MFA_PURPOSE = "passkey_mfa";
export const PASSKEY_MFA_TICKET_TTL = "5m";

export interface WebAuthnConfig {
  rpID: string;
  rpName: string;
  origins: string[];
  challengeTtlMs: number;
}

export function loadWebAuthnConfig(env: NodeJS.ProcessEnv = process.env): WebAuthnConfig {
  const frontendUrl = env.FRONTEND_URL || "http://localhost:3000";
  let frontendHost = "localhost";
  try {
    frontendHost = new URL(frontendUrl).hostname;
  } catch {
    // Keep localhost for a malformed FRONTEND_URL
  }

  const origins = (env.WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const ttlSeconds = Number(env.WEBAUTHN_CHALLENGE_TTL_SECONDS);

  return {
    rpID: env.WEBAUTHN_RP_ID?.trim() || frontendHost,
    rpName: env.WEBAUTHN_RP_NAME?.trim() || "FantasyXI",
    origins: origins.length > 0 ? origins : [frontendUrl.replace(/\/+$/, "")],
    challengeTtlMs: (Number.isInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 300) * 1000,
  };
}
