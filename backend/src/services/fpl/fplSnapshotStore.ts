/**
 * L3 fallback tier for the FPL client (issue #275): the last good upstream
 * payload per endpoint, persisted in PostgreSQL so it survives process
 * restarts and Redis flushes. Read only when the circuit is open (or the
 * upstream is failing) and both the in-memory and Redis tiers are cold.
 */

export interface FplSnapshot<T = unknown> {
  data: T;
  capturedAt: Date;
}

export interface FplSnapshotStore {
  load<T>(cacheKey: string): Promise<FplSnapshot<T> | null>;
  save(cacheKey: string, data: unknown): Promise<void>;
}

/** Minimal Prisma delegate surface, so tests can inject an in-memory fake. */
export interface FplSnapshotDelegate {
  findUnique(args: {
    where: { cacheKey: string };
  }): Promise<{ payload: unknown; capturedAt: Date } | null>;
  upsert(args: {
    where: { cacheKey: string };
    update: { payload: any; capturedAt: Date };
    create: { cacheKey: string; payload: any; capturedAt: Date };
  }): Promise<unknown>;
}

export class PrismaFplSnapshotStore implements FplSnapshotStore {
  private delegatePromise: Promise<FplSnapshotDelegate> | null;

  constructor(delegate?: FplSnapshotDelegate) {
    this.delegatePromise = delegate ? Promise.resolve(delegate) : null;
  }

  // The shared Prisma client is imported lazily so that constructing an
  // FplClient never opens a database pool on its own.
  private delegate(): Promise<FplSnapshotDelegate> {
    if (!this.delegatePromise) {
      this.delegatePromise = import("../../config/db.js").then(
        ({ prisma }) => (prisma as unknown as { fplApiSnapshot: FplSnapshotDelegate }).fplApiSnapshot
      );
    }
    return this.delegatePromise;
  }

  public async load<T>(cacheKey: string): Promise<FplSnapshot<T> | null> {
    const row = await (await this.delegate()).findUnique({ where: { cacheKey } });
    return row ? { data: row.payload as T, capturedAt: row.capturedAt } : null;
  }

  public async save(cacheKey: string, data: unknown): Promise<void> {
    const capturedAt = new Date();
    await (await this.delegate()).upsert({
      where: { cacheKey },
      update: { payload: data, capturedAt },
      create: { cacheKey, payload: data, capturedAt },
    });
  }
}

/** In-process snapshot store for tests and database-less environments. */
export class MemoryFplSnapshotStore implements FplSnapshotStore {
  public readonly snapshots = new Map<string, FplSnapshot>();

  public async load<T>(cacheKey: string): Promise<FplSnapshot<T> | null> {
    return (this.snapshots.get(cacheKey) as FplSnapshot<T> | undefined) ?? null;
  }

  public async save(cacheKey: string, data: unknown): Promise<void> {
    this.snapshots.set(cacheKey, { data, capturedAt: new Date() });
  }
}
