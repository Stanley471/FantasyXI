import crypto from "crypto";

/**
 * Service-to-service authentication for automated callers (schedulers,
 * workers, monitoring) that need the SERVICE role.
 *
 * Keys are configured as comma-separated `name:key` pairs:
 *   SERVICE_API_KEYS="scheduler:<random>,monitoring:<random>"
 * and presented in the `X-Service-Key` request header. Generate a key with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Laravel equivalent: Sanctum personal access tokens issued to a machine user.
 */

export const SERVICE_KEY_HEADER = "x-service-key";
export const MIN_SERVICE_KEY_LENGTH = 32;

export interface ServicePrincipal {
  name: string;
}

interface ConfiguredKey {
  name: string;
  digest: Buffer;
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/**
 * Parses SERVICE_API_KEYS. Malformed entries and keys shorter than
 * MIN_SERVICE_KEY_LENGTH are ignored so a weak key can never authenticate.
 */
export function parseServiceApiKeys(raw: string | undefined): ConfiguredKey[] {
  if (!raw) return [];

  const keys: ConfiguredKey[] = [];
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf(":");
    const name = entry.slice(0, separator).trim();
    const key = entry.slice(separator + 1).trim();
    if (separator <= 0 || !/^[a-z0-9_-]+$/i.test(name)) {
      console.warn("[auth] Ignoring malformed SERVICE_API_KEYS entry");
      continue;
    }
    if (key.length < MIN_SERVICE_KEY_LENGTH) {
      console.warn(
        `[auth] Ignoring service key for "${name}": keys must be at least ${MIN_SERVICE_KEY_LENGTH} characters`
      );
      continue;
    }
    keys.push({ name, digest: sha256(key) });
  }
  return keys;
}

let cachedKeys: { raw: string | undefined; keys: ConfiguredKey[] } | null = null;

/**
 * Returns the service principal owning `presentedKey`, or null. Every
 * configured key is compared in constant time.
 */
export function authenticateServiceKey(
  presentedKey: string,
  raw: string | undefined = process.env.SERVICE_API_KEYS
): ServicePrincipal | null {
  if (!presentedKey) return null;

  if (!cachedKeys || cachedKeys.raw !== raw) {
    cachedKeys = { raw, keys: parseServiceApiKeys(raw) };
  }

  const presented = sha256(presentedKey);
  let match: ServicePrincipal | null = null;
  for (const configured of cachedKeys.keys) {
    if (crypto.timingSafeEqual(presented, configured.digest) && !match) {
      match = { name: configured.name };
    }
  }
  return match;
}
