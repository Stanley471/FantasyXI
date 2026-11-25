/**
 * FPL Adaptive Token Bucket Rate Limiter (Issue #521)
 */

import { logger } from "../../config/logger.js";

export type RequestPriority = "HIGH" | "LOW";

export interface FplRateLimiterConfig {
  rate: number;
  burst: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export class FplAdaptiveTokenBucket {
  private tokensAvailable: number;
  private lastRefillAt: number;
  private backoffUntil: number = 0;
  private consecutiveErrors: number = 0;
  private queue: Array<{ fn: () => Promise<any>; priority: RequestPriority }> = [];

  constructor(
    private config: FplRateLimiterConfig = {
      rate: 10,
      burst: 50,
      baseBackoffMs: 1000,
      maxBackoffMs: 60000,
    }
  ) {
    this.tokensAvailable = config.burst;
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillAt) / 1000;
    const tokensToAdd = elapsedSec * this.config.rate;
    this.tokensAvailable = Math.min(this.config.burst, this.tokensAvailable + tokensToAdd);
    this.lastRefillAt = now;
  }

  public recordRateLimitError(): void {
    this.consecutiveErrors++;
    const backoffMs = Math.min(
      this.config.maxBackoffMs,
      this.config.baseBackoffMs * 2 ** Math.max(0, this.consecutiveErrors - 1)
    );
    this.backoffUntil = Date.now() + backoffMs;
    logger.warn({ backoffMs }, "Rate limit hit");
  }

  public recordSuccess(): void {
    if (this.consecutiveErrors > 0) {
      this.consecutiveErrors = 0;
      logger.info("Rate limiter recovered");
    }
  }

  public async request<T>(fn: () => Promise<T>, priority: RequestPriority = "LOW"): Promise<T> {
    this.refill();

    if (this.tokensAvailable >= 1 && Date.now() > this.backoffUntil) {
      this.tokensAvailable--;
      return fn();
    }

    // Queue request
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, priority });
      this.processQueue().catch(reject);
    });
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      this.refill();

      if (this.tokensAvailable >= 1 && Date.now() > this.backoffUntil) {
        this.tokensAvailable--;
        const req = this.queue.shift();
        if (req) {
          try {
            await req.fn();
            this.recordSuccess();
          } catch (error) {
            this.recordRateLimitError();
          }
        }
      } else {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  public getState() {
    return {
      tokensAvailable: this.tokensAvailable,
      inBackoff: Date.now() < this.backoffUntil,
      queueLength: this.queue.length,
    };
  }
}

export const fplRateLimiter = new FplAdaptiveTokenBucket();
