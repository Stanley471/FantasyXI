import { api } from "./api";
import { PasskeyCredential, User } from "@/types";

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function"
  );
}

export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToUint8Array(base64url: string): Uint8Array {
  const normalized = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface RegistrationOptionsJSON {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
}

interface AuthenticationOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
}

export async function registerPasskey(
  name?: string
): Promise<{ credential: PasskeyCredential; user: User }> {
  if (!isWebAuthnSupported()) {
    throw new Error("Passkeys (WebAuthn) are not supported by this browser or device.");
  }

  const optionsRes = await api.post<{
    success: boolean;
    data: RegistrationOptionsJSON;
  }>("/api/v1/auth/passkeys/register/options", {});

  const opts = optionsRes.data;

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: base64UrlToUint8Array(opts.challenge) as BufferSource,
    rp: opts.rp,
    user: {
      id: base64UrlToUint8Array(opts.user.id) as BufferSource,
      name: opts.user.name,
      displayName: opts.user.displayName,
    },
    pubKeyCredParams: opts.pubKeyCredParams,
    timeout: opts.timeout ?? 60000,
    attestation: opts.attestation ?? "none",
    authenticatorSelection: opts.authenticatorSelection,
    excludeCredentials: (opts.excludeCredentials ?? []).map((cred) => ({
      id: base64UrlToUint8Array(cred.id) as BufferSource,
      type: "public-key" as const,
      transports: cred.transports,
    })),
  };

  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Passkey registration was cancelled.");
  }

  const attestationResponse = credential.response as AuthenticatorAttestationResponse & {
    getPublicKey?: () => ArrayBuffer | null;
    getPublicKeyAlgorithm?: () => number;
    getTransports?: () => string[];
  };

  const publicKeyDer = attestationResponse.getPublicKey?.() ?? null;
  const publicKeyAlgorithm = attestationResponse.getPublicKeyAlgorithm?.();
  const transports = attestationResponse.getTransports?.() ?? [];

  const verifyRes = await api.post<{
    success: boolean;
    message: string;
    data: { credential: PasskeyCredential; user: User };
  }>("/api/v1/auth/passkeys/register/verify", {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    name: name?.trim() || undefined,
    transports,
    response: {
      clientDataJSON: bufferToBase64Url(attestationResponse.clientDataJSON),
      attestationObject: bufferToBase64Url(attestationResponse.attestationObject),
      ...(publicKeyDer ? { publicKey: bufferToBase64Url(publicKeyDer) } : {}),
      ...(typeof publicKeyAlgorithm === "number" ? { publicKeyAlgorithm } : {}),
      transports,
    },
  });

  return verifyRes.data;
}

export async function authenticateWithPasskey(
  email?: string
): Promise<{ token: string; user: User }> {
  if (!isWebAuthnSupported()) {
    throw new Error("Passkeys (WebAuthn) are not supported by this browser or device.");
  }

  const optionsRes = await api.post<{
    success: boolean;
    data: AuthenticationOptionsJSON;
  }>("/api/v1/auth/passkeys/login/options", email?.trim() ? { email: email.trim() } : {});

  const opts = optionsRes.data;

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: base64UrlToUint8Array(opts.challenge) as BufferSource,
    rpId: opts.rpId,
    timeout: opts.timeout ?? 60000,
    userVerification: opts.userVerification ?? "preferred",
    allowCredentials: (opts.allowCredentials ?? []).map((cred) => ({
      id: base64UrlToUint8Array(cred.id) as BufferSource,
      type: "public-key" as const,
      transports: cred.transports,
    })),
  };

  const credential = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Passkey sign-in was cancelled.");
  }

  const assertionResponse = credential.response as AuthenticatorAssertionResponse;

  const verifyRes = await api.post<{
    success: boolean;
    message: string;
    data: { token: string; user: User };
  }>("/api/v1/auth/passkeys/login/verify", {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(assertionResponse.clientDataJSON),
      authenticatorData: bufferToBase64Url(assertionResponse.authenticatorData),
      signature: bufferToBase64Url(assertionResponse.signature),
      userHandle: assertionResponse.userHandle
        ? bufferToBase64Url(assertionResponse.userHandle)
        : null,
    },
  });

  return verifyRes.data;
}

export async function listUserPasskeys(): Promise<PasskeyCredential[]> {
  const res = await api.get<{
    success: boolean;
    data: PasskeyCredential[];
  }>("/api/v1/auth/passkeys");
  return res.data ?? [];
}

export async function revokeUserPasskey(
  id: string
): Promise<{ deletedId: string; user: User }> {
  const res = await api.del<{
    success: boolean;
    data: { deletedId: string; user: User };
  }>(`/api/v1/auth/passkeys/${encodeURIComponent(id)}`);
  return res.data;
}
