import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { compilePolicy } from "../services/security/permissionPolicy.js";

test("compiled policy enforces all grants and rejects forged roles/unknown permissions", () => {
  const policy = compilePolicy(["own", "admin"] as const, { USER: ["own"], ADMIN: ["own", "admin"] });
  assert.equal(policy.allows("USER", ["own"]), true);
  assert.equal(policy.allows("USER", ["own", "admin"]), false);
  assert.equal(policy.allows("ADMIN", ["own", "admin"]), true);
  for (const role of ["__proto__", "SERVICE", "ADMIN,USER", ""]) assert.equal(policy.allows(role, ["admin"]), false);
  assert.equal(policy.allows("ADMIN", ["unknown" as "admin"]), false);
  assert.equal(policy.allows("ADMIN", []), false);
  assert.throws(() => compilePolicy(["x"], { USER: ["y"] }));
});

test("policy supports more than 32 distinct permissions without bit collisions", () => {
  const permissions = Array.from({ length: 70 }, (_, i) => `p${i}`);
  const policy = compilePolicy(permissions, { USER: [permissions[0]], ADMIN: [permissions[69]] });
  assert.equal(policy.allows("USER", [permissions[69]]), false);
  assert.equal(policy.allows("ADMIN", [permissions[69]]), true);
});

test("compiled permission evaluation stays below one millisecond on average", () => {
  const policy = compilePolicy(["own", "admin"], { ADMIN: ["own", "admin"] });
  for (let i = 0; i < 1000; i++) policy.allows("ADMIN", ["admin"]);
  const start = performance.now();
  for (let i = 0; i < 100_000; i++) assert.equal(policy.allows("ADMIN", ["admin"]), true);
  const averageMs = (performance.now() - start) / 100_000;
  console.log(`compiled permission evaluation: ${averageMs.toFixed(6)} ms/request (100000 checks; excludes DB/network)`);
  assert.ok(averageMs < 1);
});
