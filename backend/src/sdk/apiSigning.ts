import { randomUUID } from "node:crypto";
import {
  API_SIGNING_HEADERS,
  canonicalBodyString,
  canonicalRequestString,
  signRequest,
} from "../services/apiSigning/requestSigner.js";

/**
 * Partner SDK for API request signing (issue #455).
 *
 * Usage:
 *
 * ```ts
 * import { signApiRequest } from "./sdk/apiSigning.js";
 *
 * const { headers } = signApiRequest({
 *   method: "GET",
 *   path: "/api/v1/players?page=2",
 *   secret: process.env.FANTASYXI_API_SECRET,
 * });
 * await fetch("https://api.fantasyxi.example/api/v1/players?page=2", { headers });
 * ```
 *
 * Or use `createApiSigningClient` for a `fetch` wrapper that signs every
 * request for you. The SDK signs exactly what the server verifies (same
 * canonical string — see `services/apiSigning/requestSigner.ts`), so a
 * signature produced here passes `middleware/requestSigning.ts` unchanged.
 *
 * Rules partners must follow:
 * - Sign the exact path you request, including the query string.
 * - Sign the exact body you send. Pass the body as a string to sign those
 *   bytes, or as an object and the SDK canonicalizes it (key-sorted JSON);
 *   the server canonicalizes parsed JSON the same way.
 * - Reuse a nonce never: generate a fresh UUID per request.
 * - Keep the secret server-side. Never ship it in a browser bundle.
 */

export { canonicalRequestString } from "../services/apiSigning/requestSigner.js";

export interface SignApiRequestInput {
  method: string;
  /** Request path including query string, e.g. `/api/v1/players?page=2`. */
  path: string;
  /** Raw body string/Buffer, JSON-able object, or undefined for no body. */
  body?: unknown;
  /** The partner's secret API key. */
  secret: string;
  /** Epoch seconds (or ms); defaults to now. */
  timestamp?: string | number;
  /** Defaults to a fresh UUID. */
  nonce?: string;
}

export interface SignedApiRequest {
  signature: string;
  timestamp: string;
  nonce: string;
  canonicalString: string;
  headers: Record<string, string>;
}

/** Builds the `X-Signature` / `X-Timestamp` / `X-Nonce` headers for a request. */
export function signApiRequest(input: SignApiRequestInput): SignedApiRequest {
  if (!input.secret) throw new Error("signApiRequest requires a secret API key");
  const signed = signRequest({
    method: input.method,
    path: input.path,
    body: input.body,
    secret: input.secret,
    timestamp: input.timestamp,
    nonce: input.nonce,
  });
  return {
    signature: signed.signature,
    timestamp: signed.timestamp,
    nonce: signed.nonce,
    canonicalString: signed.canonicalString,
    headers: {
      [API_SIGNING_HEADERS.signature]: signed.signature,
      [API_SIGNING_HEADERS.timestamp]: signed.timestamp,
      [API_SIGNING_HEADERS.nonce]: signed.nonce,
    },
  };
}

export interface ApiSigningClientConfig {
  /** Base URL, e.g. `https://api.fantasyxi.example` (no trailing slash). */
  baseUrl: string;
  /** The partner's secret API key. */
  secret: string;
  /** Fetch implementation; defaults to the global `fetch`. Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface ApiSigningClient {
  /** Signs and performs a request against `baseUrl + path`. */
  signedFetch(path: string, init?: RequestInit & { body?: unknown }): Promise<Response>;
  /** Signs a request without sending it (same output as `signApiRequest`). */
  sign(path: string, init?: { method?: string; body?: unknown }): SignedApiRequest;
}

/**
 * A minimal client that signs every request with the partner's secret key.
 * `init.body` may be a string (signed byte-exact) or an object (sent as
 * canonical JSON with `Content-Type: application/json`).
 */
export function createApiSigningClient(config: ApiSigningClientConfig): ApiSigningClient {
  if (!config.secret) throw new Error("createApiSigningClient requires a secret API key");
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  const sign = (
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): SignedApiRequest => {
    // Object bodies are canonicalized (key-sorted JSON) before signing, and
    // the same canonical bytes are sent on the wire, so the server — which
    // re-canonicalizes the parsed JSON — verifies the identical body hash.
    const body =
      init.body !== undefined && typeof init.body !== "string" && !Buffer.isBuffer(init.body)
        ? canonicalBodyString(init.body)
        : init.body;
    return signApiRequest({
      method: init.method ?? "GET",
      path,
      body,
      secret: config.secret,
    });
  };

  const signedFetch = async (
    path: string,
    init: RequestInit & { body?: unknown } = {}
  ): Promise<Response> => {
    const { body, headers, ...rest } = init;
    const isObjectBody =
      body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body);
    const requestBody = isObjectBody ? canonicalBodyString(body) : body;
    const signed = sign(path, { method: init.method ?? "GET", body: requestBody });
    const requestHeaders: Record<string, string> = {
      ...(headers as Record<string, string> | undefined),
      ...signed.headers,
    };
    if (isObjectBody) {
      requestHeaders["Content-Type"] ??= "application/json";
    }
    return fetchImpl(`${baseUrl}${path}`, {
      ...rest,
      headers: requestHeaders,
      body: requestBody as BodyInit | undefined,
    });
  };

  return { signedFetch, sign };
}

/** Generates a fresh nonce (UUID v4). */
export function generateNonce(): string {
  return randomUUID();
}
