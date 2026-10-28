import { it } from "node:test";
import assert from "node:assert/strict";
import { PrimaryReadGuard, PrimaryReadUnavailableError } from "../config/primaryReadGuard.js";

it("bounds in-flight primary fallback reads without blocking writes or serving stale data", async () => {
  const guard = new PrimaryReadGuard({ maxConcurrent: 1 });
  let complete!: () => void;
  const held = guard.run(() => new Promise<void>(resolve => { complete = resolve; }));
  await assert.rejects(guard.run(async () => 1), PrimaryReadUnavailableError);
  complete(); await held;
  assert.equal(await guard.run(async () => 2), 2);
});
it("opens after connection failures and admits a single recovery probe", async () => {
  let now = 0;
  const guard = new PrimaryReadGuard({ failureThreshold: 1, cooldownMs: 100, now: () => now });
  await assert.rejects(guard.run(async () => { throw new Error("ECONNRESET"); }));
  await assert.rejects(guard.run(async () => 1), PrimaryReadUnavailableError);
  now = 100;
  let complete!: () => void;
  const probe = guard.run(() => new Promise<void>(resolve => { complete = resolve; }));
  await assert.rejects(guard.run(async () => 1), PrimaryReadUnavailableError);
  complete(); await probe;
  assert.equal(await guard.run(async () => 3), 3);
});
