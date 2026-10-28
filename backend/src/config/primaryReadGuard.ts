/** Bounds fallback reads so a lagging replica cannot exhaust the writer pool. */
export class PrimaryReadUnavailableError extends Error {
  readonly statusCode = 503;
  constructor() { super("Primary read capacity temporarily unavailable; retry shortly"); }
}

export class PrimaryReadGuard {
  private active = 0;
  private failures = 0;
  private openUntil = 0;
  private probing = false;
  constructor(private readonly options: {
    maxConcurrent?: number; failureThreshold?: number; cooldownMs?: number; now?: () => number;
  } = {}) {}

  async run<T>(query: () => Promise<T>): Promise<T> {
    const now = this.options.now ?? Date.now;
    const halfOpen = this.openUntil > 0;
    if (this.active >= (this.options.maxConcurrent ?? 20) || now() < this.openUntil || (halfOpen && this.probing)) {
      throw new PrimaryReadUnavailableError();
    }
    this.active++;
    if (halfOpen) this.probing = true;
    try {
      const result = await query();
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // Constraint/not-found errors do not indicate writer saturation.
      if (!(code && /^P2\d{3}$/.test(code) && !["P2024", "P2028"].includes(code))) {
        if (++this.failures >= (this.options.failureThreshold ?? 3)) {
          this.openUntil = now() + (this.options.cooldownMs ?? 1_000);
        }
      }
      throw error;
    } finally {
      this.active--;
      if (halfOpen) this.probing = false;
    }
  }
}
