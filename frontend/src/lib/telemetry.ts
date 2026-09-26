export interface TelemetryEvent {
  type: 'web-vital' | 'error' | 'custom';
  name: string;
  value?: number;
  rating?: 'good' | 'needs-improvement' | 'poor';
  metadata?: Record<string, string | number | boolean>;
  timestamp: number;
}

const queue: TelemetryEvent[] = [];
const BATCH_INTERVAL_MS = 5000;
const BATCH_MAX_SIZE = 20;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Web Vitals thresholds (ms / score)
// https://web.dev/vitals/
const THRESHOLDS: Record<string, [number, number]> = {
  LCP:  [2500, 4000],
  FID:  [100,  300],
  CLS:  [0.1,  0.25],
  TTFB: [800,  1800],
  INP:  [200,  500],
};

export function getRating(name: string, value: number): TelemetryEvent['rating'] {
  const thresholds = THRESHOLDS[name.toUpperCase()];
  if (!thresholds) return 'good';
  const [good, poor] = thresholds;
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}

/** Exposed for testing only — returns current queue length. */
export function getQueueLength(): number {
  return queue.length;
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, BATCH_INTERVAL_MS);
}

export function track(event: Omit<TelemetryEvent, 'timestamp'>): void {
  const telemetryEvent: TelemetryEvent = {
    ...event,
    timestamp: Date.now(),
  };
  queue.push(telemetryEvent);

  // Flush immediately when batch is full
  if (queue.length >= BATCH_MAX_SIZE) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
    return;
  }

  scheduleFlush();
}

export function flush(): void {
  if (queue.length === 0) return;
  const events = queue.splice(0);
  const payload = JSON.stringify({ events });

  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon('/api/telemetry', payload);
  } else {
    fetch('/api/telemetry', {
      method: 'POST',
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }
}

export function trackError(error: Error, componentStack?: string): void {
  track({
    type: 'error',
    name: error.name || 'UnknownError',
    metadata: {
      message: error.message.substring(0, 200),
      stack: (componentStack || error.stack || '').substring(0, 500),
    },
  });
}

export function initWebVitals(): void {
  if (typeof window === 'undefined' || !('PerformanceObserver' in window)) return;

  // ── LCP ──────────────────────────────────────────────────────────────────
  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number };
      const value = last.startTime;
      track({
        type: 'web-vital',
        name: 'LCP',
        value,
        rating: getRating('LCP', value),
      });
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // LCP not supported in this browser
  }

  // ── CLS ──────────────────────────────────────────────────────────────────
  try {
    let clsValue = 0;
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const layoutShift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!layoutShift.hadRecentInput) {
          clsValue += layoutShift.value;
        }
      }
      track({
        type: 'web-vital',
        name: 'CLS',
        value: clsValue,
        rating: getRating('CLS', clsValue),
      });
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
  } catch {
    // CLS not supported in this browser
  }

  // ── FID ──────────────────────────────────────────────────────────────────
  try {
    const fidObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const fidEntry = entry as PerformanceEntry & { processingStart: number };
        const value = fidEntry.processingStart - entry.startTime;
        track({
          type: 'web-vital',
          name: 'FID',
          value,
          rating: getRating('FID', value),
        });
      }
    });
    fidObserver.observe({ type: 'first-input', buffered: true });
  } catch {
    // FID not supported in this browser
  }

  // ── TTFB ─────────────────────────────────────────────────────────────────
  try {
    const navObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length === 0) return;
      const navEntry = entries[0] as PerformanceNavigationTiming;
      const value = navEntry.responseStart - navEntry.requestStart;
      track({
        type: 'web-vital',
        name: 'TTFB',
        value,
        rating: getRating('TTFB', value),
      });
    });
    navObserver.observe({ type: 'navigation', buffered: true });
  } catch {
    // Navigation timing not supported in this browser
  }

  // ── Flush on page hide / unload ───────────────────────────────────────────
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('beforeunload', flush);
}
