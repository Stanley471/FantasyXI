import { ed25519 } from "@noble/curves/ed25519.js";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { api } from "@/lib/api";
import type { User } from "@/types";

const DOMAIN = "FantasyXI passkey recovery v1";

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function keyPair(mnemonicInput: string) {
  const mnemonic = mnemonicInput.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("Enter the complete 12-word recovery phrase.");
  const seed = mnemonicToSeedSync(mnemonic, DOMAIN);
  return ed25519.keygen(seed.slice(0, 32));
}

export function createRecoveryPhrase(): { mnemonic: string; publicKey: string } {
  const mnemonic = generateMnemonic(wordlist, 128);
  return { mnemonic, publicKey: encode(keyPair(mnemonic).publicKey) };
}

export function signRecoveryChallenge(mnemonic: string, challenge: string): string {
  const { secretKey } = keyPair(mnemonic);
  return encode(ed25519.sign(decode(challenge), secretKey));
}

export async function configurePasskeyRecovery(): Promise<string> {
  const recovery = createRecoveryPhrase();
  await api.post("/api/v1/auth/webauthn/recovery/configure", { publicKey: recovery.publicKey });
  return recovery.mnemonic;
}

export interface RecoverySession {
  token: string;
  refreshToken?: string;
  user: User;
  requiresPasskeyRegistration: true;
}

export async function recoverPasskeyAccount(email: string, mnemonic: string): Promise<RecoverySession> {
  const begun = await api.post<{
    data: { challengeId: string; challenge: string; expiresAt: string };
  }>("/api/v1/auth/webauthn/recovery/begin", { email: email.trim().toLowerCase() });
  const { challengeId, challenge } = begun.data;
  const signature = signRecoveryChallenge(mnemonic, challenge);
  return (
    await api.post<{ data: RecoverySession }>("/api/v1/auth/webauthn/recovery/complete", {
      challengeId,
      challenge,
      signature,
    })
  ).data;
}
