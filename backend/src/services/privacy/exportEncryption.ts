import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

export function validateExportKey(pem: unknown): string {
  if (typeof pem !== "string" || pem.length > 16_384 || !/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(pem)) throw new Error("An RSA public key is required");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || (key.asymmetricKeyDetails?.modulusLength ?? 0) > 8192) throw new Error("RSA key must be between 2048 and 8192 bits");
  return key.export({ type: "spki", format: "pem" }).toString();
}

/** Only the recipient's private key can unwrap the one-export AES key. */
export function encryptExport(plain: Buffer, publicKey: string): Buffer {
  const key = randomBytes(32), iv = randomBytes(12);
  const aad = Buffer.from("FantasyXI user export v1");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const wrappedKey = publicEncrypt({ key: validateExportKey(publicKey), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
    return Buffer.from(JSON.stringify({ version: 1, cipher: "AES-256-GCM", wrapping: "RSA-OAEP-SHA256", aad: aad.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), wrappedKey: wrappedKey.toString("base64"), ciphertext: ciphertext.toString("base64") }));
  } finally { key.fill(0); plain.fill(0); }
}
