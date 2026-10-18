/**
 * Passkey (WebAuthn) helpers for the browser (issue #273).
 *
 * The backend returns ceremony options as JSON (binary fields base64url
 * encoded). These helpers convert them for navigator.credentials, run the
 * ceremony, and serialize the credential back to JSON for verification.
 */

import { api } from "@/lib/api";
import type { ApiSuccessResponse, MfaChallenge, User } from "@/types";

export interface PasskeySession {
  token: string;
  user: User;
}

export interface PasskeySummary {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

type CredentialDescriptorJSON = { id: string; type?: string; transports?: string[] };

export interface CreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: CredentialDescriptorJSON[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

export interface RequestOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  allowCredentials?: CredentialDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
}

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toDescriptor(descriptor: CredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return {
    type: "public-key",
    id: base64UrlToBuffer(descriptor.id),
    transports: descriptor.transports as AuthenticatorTransport[] | undefined,
  };
}

export function toCreationOptions(json: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    ...json,
    challenge: base64UrlToBuffer(json.challenge),
    user: { ...json.user, id: base64UrlToBuffer(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map(toDescriptor),
  };
}

export function toRequestOptions(json: RequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    ...json,
    challenge: base64UrlToBuffer(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map(toDescriptor),
  };
}

/** Serializes the result of navigator.credentials.create() for the server. */
export function serializeRegistration(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

/** Serializes the result of navigator.credentials.get() for the server. */
export function serializeAssertion(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator?.credentials?.get === "function"
  );
}

/** Whether a login response asks for the passkey step-up instead of returning a session. */
export function isMfaChallenge(data: unknown): data is MfaChallenge {
  return Boolean(data && typeof data === "object" && (data as MfaChallenge).mfaRequired === true);
}

async function getAssertion(options: RequestOptionsJSON) {
  const credential = (await navigator.credentials.get({
    publicKey: toRequestOptions(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was selected.");
  return serializeAssertion(credential);
}

/** Passwordless sign-in. Without an email the browser offers any passkey saved for this site. */
export async function signInWithPasskey(email?: string): Promise<PasskeySession> {
  const options = await api.post<ApiSuccessResponse<RequestOptionsJSON>>(
    "/api/v1/auth/passkeys/login/options",
    email ? { email } : {}
  );
  const response = await getAssertion(options.data);
  const result = await api.post<ApiSuccessResponse<PasskeySession>>("/api/v1/auth/passkeys/login/verify", {
    response,
  });
  return result.data;
}

/** Finishes a password login that requires a passkey step-up. */
export async function completePasskeyMfa(mfaToken: string): Promise<PasskeySession> {
  const options = await api.post<ApiSuccessResponse<RequestOptionsJSON>>("/api/v1/auth/passkeys/mfa/options", {
    mfaToken,
  });
  const response = await getAssertion(options.data);
  const result = await api.post<ApiSuccessResponse<PasskeySession>>("/api/v1/auth/passkeys/mfa/verify", {
    mfaToken,
    response,
  });
  return result.data;
}

/** Adds a passkey to the signed-in account. */
export async function registerPasskey(name?: string): Promise<PasskeySummary> {
  const options = await api.post<ApiSuccessResponse<CreationOptionsJSON>>(
    "/api/v1/auth/passkeys/register/options",
    {}
  );
  const credential = (await navigator.credentials.create({
    publicKey: toCreationOptions(options.data),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation was cancelled.");
  const result = await api.post<ApiSuccessResponse<PasskeySummary>>("/api/v1/auth/passkeys/register/verify", {
    response: serializeRegistration(credential),
    name,
  });
  return result.data;
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  return (await api.get<ApiSuccessResponse<PasskeySummary[]>>("/api/v1/auth/passkeys")).data;
}

export async function removePasskey(id: string): Promise<void> {
  await api.del(`/api/v1/auth/passkeys/${encodeURIComponent(id)}`);
}

export async function setPasskeyMfa(enabled: boolean, currentPassword: string): Promise<boolean> {
  const result = await api.put<ApiSuccessResponse<{ passkeyMfaEnabled: boolean }>>("/api/v1/auth/passkeys/mfa", {
    enabled,
    currentPassword,
  });
  return result.data.passkeyMfaEnabled;
}
