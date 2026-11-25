/**
 * Streaming file encryption for the database backup pipeline (issue #504).
 *
 * AES-256-GCM: a random 12-byte IV is generated per backup and the 16-byte
 * auth tag is appended to the ciphertext so decryption can verify integrity
 * without a separate signature file.
 *
 * Output layout: [12-byte IV][ciphertext...][16-byte auth tag]
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export const ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const IV_LENGTH_BYTES = 12;
export const AUTH_TAG_LENGTH_BYTES = 16;

export interface EncryptFileResult {
  /** SHA-256 of the ENCRYPTED output file, for post-upload integrity checks. */
  sha256: string;
  /** Size in bytes of the encrypted output file. */
  sizeBytes: number;
}

/** Derives a 32-byte key from the configured secret so any passphrase length works. */
export function deriveEncryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Encrypts `inputPath` into `outputPath` with AES-256-GCM, streaming so the
 * whole backup never has to fit in memory at once.
 */
export async function encryptFile(
  inputPath: string,
  outputPath: string,
  secret: string
): Promise<EncryptFileResult> {
  const key = deriveEncryptionKey(secret);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const outputHash = createHash("sha256");
  let sizeBytes = 0;

  const output = createWriteStream(outputPath);
  output.write(iv);
  outputHash.update(iv);
  sizeBytes += iv.length;

  cipher.on("data", (chunk: Buffer) => {
    outputHash.update(chunk);
    sizeBytes += chunk.length;
  });

  await pipeline(createReadStream(inputPath), cipher, output, { end: false });

  const authTag = cipher.getAuthTag();
  outputHash.update(authTag);
  sizeBytes += authTag.length;
  await new Promise<void>((resolve, reject) => {
    output.end(authTag, (err?: Error | null) => (err ? reject(err) : resolve()));
  });

  return { sha256: outputHash.digest("hex"), sizeBytes };
}

/**
 * Decrypts a file produced by {@link encryptFile}. Only used by tests and
 * restore tooling to verify the encryption round-trips correctly; the backup
 * pipeline itself never needs to decrypt.
 */
export async function decryptFile(inputPath: string, secret: string): Promise<Buffer> {
  const key = deriveEncryptionKey(secret);
  const raw = await readFile(inputPath);
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(raw.length - AUTH_TAG_LENGTH_BYTES);
  const ciphertext = raw.subarray(IV_LENGTH_BYTES, raw.length - AUTH_TAG_LENGTH_BYTES);

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
