export interface TelemetryEvent {
  type: "web-vital" | "error" | "network" | "resource" | "custom";
  name: string;
  value?: number;
  rating?: "good" | "needs-improvement" | "poor";
  metadata?: Record<string, string | number | boolean>;
  timestamp: number;
  count?: number;
}

const queue = new Map<string, TelemetryEvent>();
const BATCH_INTERVAL_MS = 5_000;
const BATCH_MAX_SIZE = 20;
const MAX_RETRY_MS = 60_000;
const SENSITIVE_KEY = /authorization|cookie|password|token|secret|email|phone|address|name/i;
const SENSITIVE_VALUE = /(bearer\s+[\w.-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d[ -]*?){13,19}\b)/gi;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let cacheFailureCount = 0;
let diagnosticsInitialized = false;

const THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  FID: [100, 300],
  CLS: [0.1, 0.25],
  TTFB: [800, 1800],
  INP: [200, 500],
};

export function getRating(name: string, value: number): TelemetryEvent["rating"] {
  const thresholds = THRESHOLDS[name.toUpperCase()];
  if (!thresholds) return "good";
  const [good, poor] = thresholds;
  if (value <= good) return "good";
  if (value <= poor) return "needs-improvement";
  return "poor";
}

export function sanitizeTelemetryValue(value: unknown, key = "", depth = 0): string | number | boolean {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth > 3) return "[TRUNCATED]";
  if (typeof value === "string") return value.slice(0, 1_000).replace(SENSITIVE_VALUE, "[REDACTED]");
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, (nestedKey, nestedValue) => {
    if (SENSITIVE_KEY.test(nestedKey)) return "[REDACTED]";
    if (typeof nestedValue === "string") return nestedValue.slice(0, 1_000).replace(SENSITIVE_VALUE, "[REDACTED]");
    return nestedValue;
  }).slice(0, 2_000);
}

function sanitizeMetadata(metadata?: Record<string, string | number | boolean>) {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, 30)
      .map(([key, value]) => [key, sanitizeTelemetryValue(value, key)])
  );
}

function fingerprint(event: Omit<TelemetryEvent, "timestamp" | "count">): string {
  const metadata = event.metadata ?? {};
  return [event.type, event.name, metadata.boundary ?? "", metadata.url ?? "", metadata.message ?? ""].join(":");
}

export function getQueueLength(): number {
  return queue.size;
}

function scheduleFlush(delay = BATCH_INTERVAL_MS): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, delay);
  if (typeof flushTimer === "object" && flushTimer !== null && "unref" in flushTimer) {
    (flushTimer as { unref?: () => void }).unref?.();
  }
}

export function track(event: Omit<TelemetryEvent, "timestamp" | "count">): void {
  const clean = { ...event, metadata: sanitizeMetadata(event.metadata) };
  const key = fingerprint(clean);
  const existing = queue.get(key);
  if (existing) {
    existing.count = (existing.count ?? 1) + 1;
    existing.timestamp = Date.now();
  } else {
    queue.set(key, { ...clean, timestamp: Date.now(), count: 1 });
  }
  if (queue.size >= BATCH_MAX_SIZE) flush();
  else scheduleFlush();
}

function endpoint(): string {
  const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
  return `${base.replace(/\/$/, "")}/api/telemetry`;
}

function restore(events: TelemetryEvent[]): void {
  for (const event of events) {
    const key = fingerprint(event);
    const existing = queue.get(key);
    if (existing) existing.count = (existing.count ?? 1) + (event.count ?? 1);
    else queue.set(key, event);
  }
  retryAttempt++;
  scheduleFlush(Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(retryAttempt, 6)));
  notifyHealth();
}

export function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.size === 0) return;
  const events = [...queue.values()];
  queue.clear();
  const payload = JSON.stringify({ events });
  const url = endpoint();
  if (typeof navigator !== "undefined" && navigator.sendBeacon?.(url, payload)) {
    retryAttempt = 0;
    return;
  }
  if (typeof fetch === "undefined") {
    restore(events);
    return;
  }
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  })
    .then((response) => {
      if (!response.ok) throw new Error(`Telemetry endpoint returned ${response.status}`);
      retryAttempt = 0;
      notifyHealth();
    })
    .catch(() => restore(events));
}

export function trackError(
  error: Error,
  componentStack?: string,
  extraMetadata?: Record<string, string | number | boolean>
): void {
  track({
    type: "error",
    name: error.name || "UnknownError",
    metadata: {
      ...extraMetadata,
      message: (error.message || "").substring(0, 200),
      stack: (componentStack || error.stack || "").substring(0, 500),
    },
  });
}

export function trackApiLatency(method: string, path: string, durationMs: number, status: number): void {
  track({
    type: "network",
    name: "api-latency",
    value: Math.round(durationMs),
    rating: durationMs <= 500 ? "good" : durationMs <= 2_000 ? "needs-improvement" : "poor",
    metadata: { method, path: path.split("?")[0], status },
  });
}

export function useErrorReporter(boundaryName?: string) {
  return (error: Error, componentStack?: string) =>
    trackError(error, componentStack, boundaryName ? { boundary: boundaryName } : undefined);
}

export type NetworkHealth = "healthy" | "offline" | "degraded";

export function getNetworkHealthSnapshot(): NetworkHealth {
  if (typeof navigator !== "undefined" && !navigator.onLine) return "offline";
  return retryAttempt >= 2 || cacheFailureCount >= 2 ? "degraded" : "healthy";
}

function notifyHealth(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new window.CustomEvent("fantasyxi-network-health", { detail: getNetworkHealthSnapshot() }));
  }
}

export async function repairLocalCache(): Promise<void> {
  if (typeof window === "undefined") return;
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (key?.startsWith("fxi:") || key?.startsWith("fantasyxi-offline")) localStorage.removeItem(key);
  }
  if ("caches" in window) {
    await Promise.all((await caches.keys()).filter((key) => key.startsWith("fantasyxi")).map((key) => caches.delete(key)));
  }
  if ("indexedDB" in window) {
    for (const database of ["fantasyxi-offline-queue", "fantasyxi-offline-store"]) indexedDB.deleteDatabase(database);
  }
  const registration = await navigator.serviceWorker?.getRegistration();
  registration?.active?.postMessage({ type: "CLEAR_RUNTIME_CACHES_AND_RESYNC" });
  cacheFailureCount = 0;
  retryAttempt = 0;
  window.dispatchEvent(new window.CustomEvent("fantasyxi-cache-repaired"));
  track({ type: "custom", name: "local-cache-repaired" });
}

export function initClientDiagnostics(): () => void {
  if (typeof window === "undefined" || diagnosticsInitialized) return () => {};
  diagnosticsInitialized = true;
  const onError = (event: ErrorEvent) => trackError(event.error instanceof Error ? event.error : new Error(event.message));
  const onUnhandled = (event: PromiseRejectionEvent) =>
    trackError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)), undefined, { source: "unhandledrejection" });
  const onResourceError = (event: Event) => {
    const target = event.target as HTMLImageElement | HTMLScriptElement | HTMLLinkElement | null;
    const url = target && ("src" in target ? target.src : "href" in target ? target.href : "");
    if (url) track({ type: "resource", name: "resource-load-failed", metadata: { url: url.split("?")[0] } });
  };
  const onOffline = () => {
    track({ type: "network", name: "offline-transition" });
    notifyHealth();
  };
  const onOnline = () => {
    track({ type: "network", name: "online-transition" });
    flush();
    notifyHealth();
  };
  const onServiceWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type !== "FANTASYXI_CACHE_ERROR") return;
    cacheFailureCount++;
    track({
      type: "resource",
      name: "service-worker-cache-error",
      metadata: { cache: String(event.data.cacheName ?? "unknown") },
    });
    notifyHealth();
  };
  window.addEventListener("error", onError);
  window.addEventListener("error", onResourceError, true);
  window.addEventListener("unhandledrejection", onUnhandled);
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
  return () => {
    diagnosticsInitialized = false;
    window.removeEventListener("error", onError);
    window.removeEventListener("error", onResourceError, true);
    window.removeEventListener("unhandledrejection", onUnhandled);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
  };
}

export function initWebVitals(): void {
  if (typeof window === "undefined" || !("PerformanceObserver" in window)) return;
  const observe = (type: string, callback: (entry: PerformanceEntry) => void) => {
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach(callback));
      observer.observe({ type, buffered: true });
    } catch {
      // Unsupported performance entry type.
    }
  };
  observe("largest-contentful-paint", (entry) => {
    const value = entry.startTime;
    track({ type: "web-vital", name: "LCP", value, rating: getRating("LCP", value) });
  });
  let cls = 0;
  observe("layout-shift", (entry) => {
    const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
    if (!shift.hadRecentInput) cls += shift.value;
    track({ type: "web-vital", name: "CLS", value: cls, rating: getRating("CLS", cls) });
  });
  observe("first-input", (entry) => {
    const value = (entry as PerformanceEntry & { processingStart: number }).processingStart - entry.startTime;
    track({ type: "web-vital", name: "FID", value, rating: getRating("FID", value) });
  });
  observe("navigation", (entry) => {
    const navigation = entry as PerformanceNavigationTiming;
    const value = navigation.responseStart - navigation.requestStart;
    track({ type: "web-vital", name: "TTFB", value, rating: getRating("TTFB", value) });
  });
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  window.addEventListener("beforeunload", flush);
}
