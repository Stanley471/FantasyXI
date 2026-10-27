/**
 * Passkey (WebAuthn) ceremonies against the FantasyXI API (issue #273).
 *
 * The browser half of the flows in backend/src/services/auth/webAuthnService.ts:
 * the server issues single-use options, the authenticator signs them, and the
 * server verifies the result. Nothing secret is stored in the browser.
 */

import { useSyncExternalStore } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { api, ApiError } from "@/lib/api";
import { computeDeviceFingerprint } from "@/lib/deviceFingerprint";
import type { User } from "@/types";

export type { PublicKeyCredentialRequestOptionsJSON };

export interface Passkey {
  id: string;
  name: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PasskeySession {
  token: string;
  user: User;
}

const subscribeNever = () => () => {};

/** Whether this browser supports passkeys; false while server rendering, so hydration matches. */
export function usePasskeySupport(): boolean {
  return useSyncExternalStore(subscribeNever, browserSupportsWebAuthn, () => false);
}

/**
 * Signs in with a passkey. Without options this is a usernameless sign-in;
 * with the options of a WEBAUTHN login challenge it completes the step-up
 * that follows a correct password.
 */
export async function authenticateWithPasskey(
  stepUpOptions?: PublicKeyCredentialRequestOptionsJSON
): Promise<PasskeySession> {
  const optionsJSON =
    stepUpOptions ??
    (await api.post<{ data: PublicKeyCredentialRequestOptionsJSON }>("/api/v1/auth/webauthn/login/options")).data;
  const response = await startAuthentication({ optionsJSON });
  const result = await api.post<{ data: PasskeySession }>("/api/v1/auth/webauthn/login/verify", {
    response,
    deviceFingerprint: (await computeDeviceFingerprint()) ?? undefined,
  });
  return result.data;
}

/** Creates a passkey on this device (or a security key) for the signed-in account. */
export async function registerPasskey(name?: string): Promise<Passkey> {
  const { data: optionsJSON } = await api.post<{ data: PublicKeyCredentialCreationOptionsJSON }>(
    "/api/v1/auth/webauthn/register/options"
  );
  const response = await startRegistration({ optionsJSON });
  return (await api.post<{ data: Passkey }>("/api/v1/auth/webauthn/register/verify", { response, name })).data;
}

export async function listPasskeys(): Promise<Passkey[]> {
  return (await api.get<{ data: Passkey[] }>("/api/v1/auth/webauthn/credentials")).data;
}

export async function deletePasskey(id: string): Promise<void> {
  await api.del(`/api/v1/auth/webauthn/credentials/${encodeURIComponent(id)}`);
}

/** User-facing text for a failed ceremony (cancelled prompt, duplicate key, API error). */
export function describePasskeyError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error && err.name === "NotAllowedError") {
    return "The passkey request was cancelled or timed out.";
  }
  if (err instanceof Error && err.name === "InvalidStateError") {
    return "This passkey is already registered to your account.";
  }
  return fallback;
}
