/**
 * Google OAuth helpers shared by the sign-in, sign-up, callback and profile pages.
 *
 * Sign-in is a top-level redirect to the backend, which redirects to Google and
 * back. Linking Google to a signed-in account first asks the API (with the
 * Bearer token) for a short-lived start URL, because a redirect cannot carry
 * the token itself.
 */
import { api, API_BASE_URL } from "@/lib/api";

/**
 * Only same-site relative paths are followed after sign-in; anything else
 * (absolute or protocol-relative URLs) falls back to the home page.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) {
    return "/";
  }
  return value;
}

/** Sends the browser to the backend's Google sign-in endpoint. */
export function redirectToGoogleSignIn(returnTo?: string | null): void {
  const url = new URL("/api/v1/auth/google", API_BASE_URL);
  const target = safeReturnTo(returnTo);
  if (target !== "/") {
    url.searchParams.set("returnTo", target);
  }
  window.location.href = url.toString();
}

/** Starts linking a Google account to the signed-in manager. */
export async function redirectToGoogleLink(): Promise<void> {
  const res = await api.post<{ success: boolean; data: { url: string } }>(
    "/api/v1/auth/google/link"
  );
  window.location.href = new URL(res.data.url, API_BASE_URL).toString();
}

const GOOGLE_AUTH_ERRORS: Record<string, string> = {
  google_denied: "Google sign-in was cancelled. Please try again.",
  oauth_state_invalid:
    "Your Google sign-in session expired or was started in another browser. Please try again.",
  google_email_unverified: "Your Google account email is not verified, so it cannot be used to sign in.",
  google_account_conflict:
    "This Google account is already linked to a different FantasyXI account.",
  google_auth_failed: "Google could not verify your account. Please try again.",
  google_not_configured: "Google sign-in is not available right now.",
  link_ticket_invalid: "The Google linking request expired. Please try again.",
  account_not_found: "Your account could not be found. Please sign in again.",
};

/** Human-readable message for an error code returned by the OAuth callback. */
export function describeGoogleAuthError(code: string | null | undefined): string | null {
  if (!code) return null;
  return GOOGLE_AUTH_ERRORS[code] ?? "Google sign-in encountered an issue. Please try again.";
}
