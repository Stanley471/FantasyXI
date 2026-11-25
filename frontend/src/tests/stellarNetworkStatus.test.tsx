import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { badgeTone, classifyNetwork, sampleNetwork, type NetworkSample } from "../lib/stellar/networkStatus";
import { StellarNetworkBadge, StellarNetworkBanner } from "../components/stellar/StellarNetworkStatus";

const RPC = "https://rpc.test";
const HORIZON = "https://horizon.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Builds a fetch mock plus a fake clock where each RPC call "takes" rpcLatency ms. */
function mockNetwork(opts: { rpc: "healthy" | "unhealthy" | "down"; rpcLatency?: number; ledgerAgeSeconds?: number }) {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === RPC) {
      if (opts.rpc === "down") throw new TypeError("fetch failed");
      clock += opts.rpcLatency ?? 40;
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: { status: opts.rpc === "healthy" ? "healthy" : "behind", latestLedger: 12345 },
      });
    }
    if (u.endsWith("/fee_stats")) {
      return json({ last_ledger: "12345", fee_charged: { p50: "100" } });
    }
    if (u.includes("/ledgers")) {
      const closed = new Date(1_700_000_000_000 - (opts.ledgerAgeSeconds ?? 3) * 1000).toISOString();
      return json({ _embedded: { records: [{ closed_at: closed }] } });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, now };
}

async function snapshot(opts: Parameters<typeof mockNetwork>[0]) {
  const { fetchImpl, now } = mockNetwork(opts);
  const sample = await sampleNetwork({ rpcUrl: RPC, horizonUrl: HORIZON, fetchImpl, now });
  return classifyNetwork(sample);
}

describe("network status classification", () => {
  it("is healthy with low latency and a fresh ledger", async () => {
    const snap = await snapshot({ rpc: "healthy", rpcLatency: 42 });
    assert.equal(snap.health, "healthy");
    assert.equal(snap.latencyMs, 42);
    assert.equal(snap.latestLedger, 12345);
    assert.equal(snap.feeP50Stroops, 100);
    assert.equal(snap.showBanner, false);
    assert.equal(badgeTone(snap), "green");
  });

  it("is degraded (amber) when RPC latency is elevated", async () => {
    const snap = await snapshot({ rpc: "healthy", rpcLatency: 2200 });
    assert.equal(snap.health, "degraded");
    assert.equal(badgeTone(snap), "amber");
    assert.match(snap.advisories[0], /latency/i);
  });

  it("is red when latency is critical", async () => {
    const snap = await snapshot({ rpc: "healthy", rpcLatency: 5000 });
    assert.equal(badgeTone(snap), "red");
  });

  it("shows the banner when the last ledger closed over 15 seconds ago", async () => {
    const snap = await snapshot({ rpc: "healthy", rpcLatency: 40, ledgerAgeSeconds: 30 });
    assert.equal(snap.health, "degraded");
    assert.equal(snap.showBanner, true);
    assert.match(snap.advisories.join(" "), /ledger closed/);
  });

  it("is offline with a banner when RPC reports unhealthy", async () => {
    const snap = await snapshot({ rpc: "unhealthy" });
    assert.equal(snap.health, "offline");
    assert.equal(snap.showBanner, true);
    assert.equal(badgeTone(snap), "red");
  });

  it("is offline when RPC is unreachable and never throws", async () => {
    const snap = await snapshot({ rpc: "down" });
    assert.equal(snap.health, "offline");
    assert.equal(snap.latencyMs, null);
  });
});

describe("StellarNetworkBadge / Banner", () => {
  const base: NetworkSample = {
    rpcHealthy: true,
    latencyMs: 42,
    latestLedger: 999,
    ledgerAgeSeconds: 4,
    feeP50Stroops: 100,
    sampledAt: 0,
  };

  it("renders a healthy badge with latency", () => {
    const html = renderToStaticMarkup(<StellarNetworkBadge snapshot={classifyNetwork(base)} />);
    assert.match(html, /Stellar Testnet: Healthy \(42ms\)/);
    assert.match(html, /bg-emerald-500/);
    assert.equal(renderToStaticMarkup(<StellarNetworkBanner snapshot={classifyNetwork(base)} />), "");
  });

  it("renders an amber badge with an advisory tooltip when degraded", () => {
    const snap = classifyNetwork({ ...base, latencyMs: 2500 });
    const html = renderToStaticMarkup(<StellarNetworkBadge snapshot={snap} />);
    assert.match(html, /Degraded/);
    assert.match(html, /bg-amber-500/);
    assert.match(html, /title="[^"]*latency is elevated/);
  });

  it("renders a red badge and alert banner when offline", () => {
    const snap = classifyNetwork({ ...base, rpcHealthy: false, latencyMs: null });
    assert.match(renderToStaticMarkup(<StellarNetworkBadge snapshot={snap} />), /Offline[\s\S]*|bg-rose-500/);
    assert.match(renderToStaticMarkup(<StellarNetworkBadge snapshot={snap} />), /bg-rose-500/);
    const banner = renderToStaticMarkup(<StellarNetworkBanner snapshot={snap} />);
    assert.match(banner, /role="alert"/);
    assert.match(banner, /Soroban RPC is unreachable/);
  });
});
