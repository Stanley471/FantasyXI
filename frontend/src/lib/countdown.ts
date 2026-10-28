export type CountdownTone = "normal" | "amber" | "red" | "expired";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Milliseconds left until `deadline`, never negative. */
export function remainingUntil(deadline: string | Date, now: number = Date.now()): number {
  const target = new Date(deadline).getTime();
  return Number.isNaN(target) ? 0 : Math.max(0, target - now);
}

/** Formats a remaining duration as e.g. "2d 14h 32m 10s". */
export function formatCountdown(remainingMs: number): string {
  const ms = Math.max(0, remainingMs);
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const seconds = Math.floor((ms % MINUTE) / SECOND);
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

/** Amber under 24 hours, red under 1 hour, expired at zero. */
export function countdownTone(remainingMs: number): CountdownTone {
  if (remainingMs <= 0) return "expired";
  if (remainingMs < HOUR) return "red";
  if (remainingMs < DAY) return "amber";
  return "normal";
}
