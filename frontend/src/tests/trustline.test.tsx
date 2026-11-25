import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair, Networks, TransactionBuilder, Operation } from "@stellar/stellar-sdk";
import {
  buildUsdcTrustlineXdr,
  checkUsdcTrustline,
  enableUsdcTrustline,
  TrustlineError,
} from "../lib/stellar/trustline";
import { TrustlinePrompt } from "../components/stellar/TrustlineGuard";

const ISSUER = Keypair.random().publicKey();
const ACCOUNT = Keypair.random().publicKey();
const HORIZON = "https://horizon.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function accountResponse(withUsdc: boolean) {
  return {
    sequence: "100",
    balances: [
      { asset_type: "native", balance: "10.0000000" },
      ...(withUsdc
        ? [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "5.0000000", limit: "922337203685.4775807" }]
        : []),
    ],
  };
}

describe("checkUsdcTrustline", () => {
  it("reports active when the USDC trustline exists", async () => {
    const fetchImpl = (async () => json(accountResponse(true))) as typeof fetch;
    const result = await checkUsdcTrustline(ACCOUNT, { horizonUrl: HORIZON, issuer: ISSUER, fetchImpl });
    assert.equal(result.status, "active");
    assert.equal(result.balance, "5.0000000");
  });

  it("reports missing when the account has no USDC line", async () => {
    const fetchImpl = (async () => json(accountResponse(false))) as typeof fetch;
    const result = await checkUsdcTrustline(ACCOUNT, { horizonUrl: HORIZON, issuer: ISSUER, fetchImpl });
    assert.equal(result.status, "missing");
  });

  it("ignores USDC from a different issuer", async () => {
    const other = Keypair.random().publicKey();
    const fetchImpl = (async () => json(accountResponse(true))) as typeof fetch;
    const result = await checkUsdcTrustline(ACCOUNT, { horizonUrl: HORIZON, issuer: other, fetchImpl });
    assert.equal(result.status, "missing");
  });

  it("reports unfunded for accounts Horizon does not know", async () => {
    const fetchImpl = (async () => json({}, 404)) as typeof fetch;
    const result = await checkUsdcTrustline(ACCOUNT, { horizonUrl: HORIZON, issuer: ISSUER, fetchImpl });
    assert.equal(result.status, "unfunded");
  });

  it("raises a network error when Horizon is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(
      checkUsdcTrustline(ACCOUNT, { horizonUrl: HORIZON, issuer: ISSUER, fetchImpl }),
      (err: unknown) => err instanceof TrustlineError && err.code === "network"
    );
  });
});

describe("buildUsdcTrustlineXdr", () => {
  it("builds a change_trust operation for the USDC asset", async () => {
    const fetchImpl = (async () => json(accountResponse(false))) as typeof fetch;
    const xdr = await buildUsdcTrustlineXdr(ACCOUNT, {
      horizonUrl: HORIZON,
      issuer: ISSUER,
      fetchImpl,
      networkPassphrase: Networks.TESTNET,
    });
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    assert.equal("operations" in tx, true);
    const op = (tx as unknown as { operations: Operation.ChangeTrust[] }).operations[0];
    const line = op.line as { code: string; issuer: string };
    assert.equal(op.type, "changeTrust");
    assert.equal(line.code, "USDC");
    assert.equal(line.issuer, ISSUER);
    assert.equal(op.limit, "922337203685.4775807");
  });

  it("refuses to build for an unfunded account", async () => {
    const fetchImpl = (async () => json({}, 404)) as typeof fetch;
    await assert.rejects(
      buildUsdcTrustlineXdr(ACCOUNT, { horizonUrl: HORIZON, issuer: ISSUER, fetchImpl }),
      (err: unknown) => err instanceof TrustlineError && err.code === "unfunded"
    );
  });
});

describe("enableUsdcTrustline", () => {
  it("signs, submits and resolves once the trustline is active", async () => {
    let accountReads = 0;
    let submitted = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/transactions") && init?.method === "POST") {
        submitted = true;
        return json({ successful: true });
      }
      accountReads++;
      // 1st read builds the tx, 2nd read is the first confirmation poll (still missing), 3rd is active.
      return json(accountResponse(accountReads >= 3));
    }) as typeof fetch;

    let signed = 0;
    const result = await enableUsdcTrustline({
      publicKey: ACCOUNT,
      horizonUrl: HORIZON,
      issuer: ISSUER,
      fetchImpl,
      pollIntervalMs: 1,
      signTransaction: async (xdr) => {
        signed++;
        return { signedTxXdr: xdr };
      },
    });
    assert.equal(result.status, "active");
    assert.equal(signed, 1);
    assert.equal(submitted, true);
  });

  it("surfaces wallet rejection without submitting", async () => {
    let submitted = false;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") submitted = true;
      return json(accountResponse(false));
    }) as typeof fetch;
    await assert.rejects(
      enableUsdcTrustline({
        publicKey: ACCOUNT,
        horizonUrl: HORIZON,
        issuer: ISSUER,
        fetchImpl,
        signTransaction: async () => {
          throw new Error("User declined");
        },
      }),
      (err: unknown) => err instanceof TrustlineError && err.code === "rejected"
    );
    assert.equal(submitted, false);
  });
});

describe("TrustlinePrompt", () => {
  it("shows the Enable USDC action when the trustline is missing", () => {
    const html = renderToStaticMarkup(<TrustlinePrompt state="missing" />);
    assert.match(html, /no USDC trustline/);
    assert.match(html, /Enable USDC/);
  });

  it("shows a confirmation when the trustline is active", () => {
    const html = renderToStaticMarkup(<TrustlinePrompt state="active" />);
    assert.match(html, /USDC trustline active/);
    assert.doesNotMatch(html, /Enable USDC/);
  });

  it("asks to fund unfunded accounts instead of offering the action", () => {
    const html = renderToStaticMarkup(<TrustlinePrompt state="unfunded" />);
    assert.match(html, /not funded/);
    assert.doesNotMatch(html, /Enable USDC/);
  });
});
