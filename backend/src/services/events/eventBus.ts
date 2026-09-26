/**
 * In-process event bus (issue #118).
 *
 * Backend services previously reacted to core game events (a gameweek being
 * updated, a user signing up) by calling each other synchronously and
 * directly - e.g. `jobs/gameweekSettlement.ts` imported and called the
 * scoring, squad, and league services in sequence. That tightly couples the
 * "trigger" to every downstream consumer: adding a new reaction meant editing
 * the trigger's code, and one consumer's exception could abort consumers that
 * had nothing to do with it.
 *
 * This module defines a small publish/subscribe abstraction (`EventBus`) and
 * an in-process implementation (`InMemoryEventBus`). Producers publish a named
 * event with a payload; consumers subscribe to that name without the producer
 * knowing (or caring) who they are.
 *
 * Scope and honest tradeoffs (a full Kafka/RabbitMQ broker is not realistically
 * testable in this environment without live infra, per issue #118):
 *  - This is in-process only: events do not survive a process crash or
 *    restart, and are not shared across multiple backend instances. A real
 *    broker (or a Redis Streams-backed `EventBus` implementation, reusing the
 *    Redis instance added for #139) would add durability and cross-process
 *    fan-out without changing a single call site, because callers only ever
 *    depend on the `EventBus` interface below.
 *  - "At-least-once" here means: within a single `publish()` call, each
 *    subscriber independently gets up to `maxAttemptsPerSubscriber` attempts
 *    (with a short delay between attempts) before it is recorded as failed.
 *    It does NOT mean an event is redelivered after the process restarts -
 *    that durability gap is exactly what a real broker would close.
 *  - Subscribers run sequentially, in subscription order, rather than
 *    concurrently. This is a deliberate simplification: some of today's
 *    subscribers have a genuine ordering dependency (see
 *    services/events/gameweekEventHandlers.ts), and a real broker would
 *    require that dependency to be expressed explicitly as a follow-up event
 *    rather than implied by call order. Running sequentially preserves
 *    today's behavior while still decoupling the producer from the list of
 *    consumers.
 *  - A subscriber throwing (even after retries) never prevents the other
 *    subscribers for that event from running - `publish()` always calls every
 *    subscriber and only reports failures afterward via the returned summary.
 */

export interface DomainEvent<T = unknown> {
  name: string;
  payload: T;
  publishedAt: Date;
}

export type EventHandler<T = unknown> = (
  payload: T,
  event: DomainEvent<T>
) => Promise<void> | void;

export interface SubscriberFailure {
  eventName: string;
  handlerName: string;
  error: Error;
  attempts: number;
}

export interface PublishOptions {
  /** Attempts per subscriber before it is recorded as failed. Default 1 (no retry). */
  maxAttemptsPerSubscriber?: number;
  /** Delay between retry attempts, in milliseconds. Default 25ms. */
  retryDelayMs?: number;
}

export interface PublishSummary {
  eventName: string;
  /** Number of subscribers that ultimately succeeded (including after retries). */
  delivered: number;
  /** Subscribers that failed on every attempt. */
  failed: SubscriberFailure[];
}

export interface EventBus {
  /**
   * Registers `handler` for `eventName`. Returns an unsubscribe function.
   * `name` identifies the handler in logs and failure reports; it defaults to
   * the function's own name.
   */
  subscribe<T>(
    eventName: string,
    handler: EventHandler<T>,
    options?: { name?: string }
  ): () => void;

  /**
   * Delivers `payload` to every current subscriber of `eventName`, in
   * subscription order. Never throws itself - failures are isolated per
   * subscriber and reported in the returned summary. Use `publishOrThrow` when
   * the caller needs to know synchronously that every subscriber succeeded.
   */
  publish<T>(
    eventName: string,
    payload: T,
    options?: PublishOptions
  ): Promise<PublishSummary>;
}

/** Raised by `publishOrThrow` when at least one subscriber failed on every attempt. */
export class SubscriberDeliveryError extends Error {
  constructor(public readonly summary: PublishSummary) {
    super(
      `Event "${summary.eventName}" delivery failed for ${summary.failed.length} subscriber(s): ` +
        summary.failed.map((f) => `${f.handlerName} (${f.error.message})`).join("; ")
    );
    this.name = "SubscriberDeliveryError";
  }
}

interface Subscription {
  name: string;
  handler: EventHandler<any>;
}

export class InMemoryEventBus implements EventBus {
  private subscribers = new Map<string, Subscription[]>();
  private failedDeliveries: SubscriberFailure[] = [];

  public subscribe<T>(
    eventName: string,
    handler: EventHandler<T>,
    options: { name?: string } = {}
  ): () => void {
    const list = this.subscribers.get(eventName) ?? [];
    const subscription: Subscription = {
      name: options.name ?? handler.name ?? `subscriber-${list.length + 1}`,
      handler,
    };
    list.push(subscription);
    this.subscribers.set(eventName, list);

    return () => {
      const current = this.subscribers.get(eventName);
      if (!current) return;
      this.subscribers.set(
        eventName,
        current.filter((s) => s !== subscription)
      );
    };
  }

  public async publish<T>(
    eventName: string,
    payload: T,
    options: PublishOptions = {}
  ): Promise<PublishSummary> {
    const maxAttempts = Math.max(1, options.maxAttemptsPerSubscriber ?? 1);
    const retryDelayMs = options.retryDelayMs ?? 25;
    const event: DomainEvent<T> = { name: eventName, payload, publishedAt: new Date() };
    const subscriptions = this.subscribers.get(eventName) ?? [];

    let delivered = 0;
    const failed: SubscriberFailure[] = [];

    for (const subscription of subscriptions) {
      let lastError: Error | null = null;
      let succeeded = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await subscription.handler(payload, event);
          succeeded = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      }

      if (succeeded) {
        delivered++;
      } else {
        const failure: SubscriberFailure = {
          eventName,
          handlerName: subscription.name,
          error: lastError ?? new Error("Unknown subscriber failure"),
          attempts: maxAttempts,
        };
        failed.push(failure);
        this.failedDeliveries.push(failure);
        console.error(
          `[eventBus] Subscriber "${subscription.name}" failed to handle "${eventName}" after ${maxAttempts} attempt(s): ${failure.error.message}`
        );
      }
      // A subscriber's outcome (success or exhausted retries) never stops the
      // loop - the next subscriber always runs.
    }

    return { eventName, delivered, failed };
  }

  /** Failures recorded across every event, for admin/observability review. */
  public getFailedDeliveries(): SubscriberFailure[] {
    return [...this.failedDeliveries];
  }

  /** Names of subscribers currently registered for `eventName`, in subscription order. */
  public listSubscriberNames(eventName: string): string[] {
    return (this.subscribers.get(eventName) ?? []).map((s) => s.name);
  }

  /** Test/ops helper: removes every subscriber and clears recorded failures. */
  public reset(): void {
    this.subscribers.clear();
    this.failedDeliveries = [];
  }
}

/** Process-wide event bus singleton used by producers and subscribers. */
export const eventBus: EventBus = new InMemoryEventBus();

/**
 * Publishes an event and throws `SubscriberDeliveryError` if any subscriber
 * failed on every attempt. Use this where the caller's own success depends on
 * every subscriber completing (e.g. gameweek settlement); use `bus.publish`
 * directly where a subscriber failure should only be logged, not block the
 * caller (e.g. a best-effort analytics handler on user signup).
 */
export async function publishOrThrow<T>(
  bus: EventBus,
  eventName: string,
  payload: T,
  options?: PublishOptions
): Promise<PublishSummary> {
  const summary = await bus.publish(eventName, payload, options);
  if (summary.failed.length > 0) {
    throw new SubscriberDeliveryError(summary);
  }
  return summary;
}
