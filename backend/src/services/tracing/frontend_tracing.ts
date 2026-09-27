/**
 * Frontend W3C Trace Context Generator & Fetch Wrapper (Issue 159)
 */

function generateHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateFrontendTraceId(): string {
  return generateHex(16); // 32 hex chars
}

export function generateFrontendSpanId(): string {
  return generateHex(8); // 16 hex chars
}

export function createTraceparentHeader(traceId?: string): { traceparent: string; traceId: string; spanId: string } {
  const tid = traceId || generateFrontendTraceId();
  const sid = generateFrontendSpanId();
  const header = `00-${tid}-${sid}-01`;
  return { traceparent: header, traceId: tid, spanId: sid };
}

/**
 * Enhanced fetch attaching W3C traceparent headers to correlate with backend requests.
 */
export async function fetchWithTracing(
  input: RequestInfo | URL,
  init?: RequestInit,
  customTraceId?: string
): Promise<Response> {
  const { traceparent } = createTraceparentHeader(customTraceId);

  const headers = new Headers(init?.headers || {});
  if (!headers.has("traceparent")) {
    headers.set("traceparent", traceparent);
  }

  return fetch(input, {
    ...init,
    headers,
  });
}
