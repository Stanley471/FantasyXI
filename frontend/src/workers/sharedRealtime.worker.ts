/**
 * Shared realtime worker (Issue #459)
 *
 * One worker per origin owns every realtime WebSocket (live points, league
 * chat, notifications) and multiplexes it across all open tabs. Tabs talk
 * to it over MessagePorts; the worker fans server frames out to every tab
 * subscribed to a channel.
 *
 * The same script serves both worker flavours:
 * - SharedWorker: browsers deliver each tab's port via `onconnect`.
 * - Dedicated Worker fallback (Safari / iOS, where SharedWorker is
 *   restricted): the tab constructs a plain `Worker` from this file and
 *   talks to it over `self` directly, via `onmessage`.
 *
 * No tab ever opens its own socket while this worker is alive, so N tabs
 * cost the server one connection per channel instead of N.
 *
 * Note: the frontend tsconfig only includes the `dom` lib, so the worker
 * global is reached through a structural cast instead of the `webworker`
 * lib's SharedWorkerGlobalScope type.
 */

import { RealtimeWorkerCore, type MinimalWebSocketFactory } from "../lib/realtime/workerCore";
import { isTabToWorkerMessage, type WorkerToTabMessage } from "../lib/realtime/protocol";

interface WorkerSelf {
  onconnect: ((event: { ports: MessagePort[] }) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
}

const workerSelf = self as unknown as WorkerSelf;

const core = new RealtimeWorkerCore({
  createSocket: Object.assign((url: string) => new WebSocket(url), {
    OPEN: WebSocket.OPEN,
    CONNECTING: WebSocket.CONNECTING,
  }) as unknown as MinimalWebSocketFactory,
});

function nextPortId(): string {
  return `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

// SharedWorker: one port per connecting tab. The core keys each tab by a
// worker-side id, so no re-keying is needed when the tab's `init` arrives.
workerSelf.onconnect = (event: { ports: MessagePort[] }) => {
  const port = event.ports[0];
  if (!port) return;
  const portId = nextPortId();
  core.addPort(portId, { postMessage: (message: WorkerToTabMessage) => port.postMessage(message) });
  port.onmessage = (e: MessageEvent) => {
    if (isTabToWorkerMessage(e.data)) core.handleMessage(portId, e.data);
  };
  port.onmessageerror = () => core.removePort(portId);
  port.start?.();
};

// Dedicated Worker fallback: the tab talks to `self` directly.
let dedicatedPortId: string | null = null;
workerSelf.onmessage = (event: MessageEvent) => {
  if (!isTabToWorkerMessage(event.data)) return;
  if (dedicatedPortId === null) {
    dedicatedPortId = nextPortId();
    core.addPort(dedicatedPortId, { postMessage: (message: WorkerToTabMessage) => workerSelf.postMessage(message) });
  }
  core.handleMessage(dedicatedPortId, event.data);
};

export { core };
