import { Prisma } from "@prisma/client";
import { SquadLockedError } from "./squadValidator.js";

/**
 * Race-free gameweek deadline enforcement.
 *
 * A deadline check done before a transaction starts is not enough: a request
 * that passes the check at 18:29:59.990 can still commit its transfers after
 * 18:30:00.000. These helpers are meant to run inside an interactive
 * transaction so that the final check happens as the last step before commit,
 * against the database clock, while the relevant rows are locked.
 *
 * Laravel equivalent: DB::transaction() combined with ->lockForUpdate() /
 * ->sharedLock() on the Eloquent query builder.
 */

/** Interactive transaction options for deadline-sensitive squad writes. */
export const DEADLINE_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 15_000,
} as const;

/**
 * True once `now` has reached the deadline. A request arriving exactly at the
 * deadline millisecond is late.
 */
export function isPastDeadline(deadline: Date, now: Date): boolean {
  return now.getTime() >= deadline.getTime();
}

/**
 * Reads the database clock. `clock_timestamp()` is used rather than `now()`
 * because `now()` is frozen at transaction start in PostgreSQL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function databaseNow(tx: any): Promise<Date> {
  const rows: Array<{ now: Date }> = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
  return new Date(rows[0].now);
}

/**
 * Takes an exclusive row lock on a squad. Concurrent edits to the same squad
 * queue here, so each one re-reads the previous one's committed state
 * (players, bank, free transfers) instead of overwriting it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lockSquadForUpdate(tx: any, squadId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM squads WHERE id = ${squadId} FOR UPDATE`;
}

/**
 * Takes shared row locks on gameweeks. The deadline-lock job's UPDATE of
 * `is_locked` waits for this transaction (and vice versa), so a gameweek
 * cannot be locked between our check and our commit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lockGameweeksForShare(tx: any, gameweekIds: number[]): Promise<void> {
  if (gameweekIds.length === 0) return;
  await tx.$queryRaw`SELECT id FROM gameweeks WHERE id IN (${Prisma.join(gameweekIds)}) FOR SHARE`;
}

/**
 * Authoritative deadline check. Call it as the last statement of the
 * transaction: it locks the gameweeks, re-reads them, reads the database clock
 * and throws SquadLockedError (rolling the transaction back) if any of them is
 * locked or has reached its deadline.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function assertGameweeksOpen(tx: any, gameweekIds: number[]): Promise<void> {
  const ids = [...new Set(gameweekIds)];
  if (ids.length === 0) return;

  await lockGameweeksForShare(tx, ids);
  const gameweeks: Array<{ deadline: Date; isLocked: boolean }> = await tx.gameweek.findMany({
    where: { id: { in: ids } },
  });
  const now = await databaseNow(tx);

  for (const gw of gameweeks) {
    if (gw.isLocked || isPastDeadline(gw.deadline, now)) {
      throw new SquadLockedError(gw.deadline);
    }
  }
}
