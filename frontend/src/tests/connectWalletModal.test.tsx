import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { classifyWalletError, connectionTypeFor } from "../lib/stellar/walletConnect";
import {
  ConnectWalletModalView,
  type ConnectWalletModalViewProps,
} from "../components/wallet/ConnectWalletModal";

const noop = () => undefined;

function props(overrides: Partial<ConnectWalletModalViewProps> = {}): ConnectWalletModalViewProps {
  return {
    wallets: [
      { id: "freighter", name: "Freighter", isAvailable: true },
      { id: "albedo", name: "Albedo", isAvailable: true },
      { id: "xbull", name: "xBull", isAvailable: true },
      { id: "wallet_connect", name: "WalletConnect", isAvailable: true },
    ],
    selectedWallet: null,
    publicKey: null,
    connectingId: null,
    error: null,
    errorCode: null,
    onConnect: noop,
    onDisconnect: noop,
    onClose: noop,
    ...overrides,
  };
}

describe("classifyWalletError", () => {
  it("detects a missing extension", () => {
    const err = classifyWalletError(new Error("Freighter is not installed"), "freighter");
    assert.equal(err.code, "not_installed");
    assert.match(err.message, /Freighter was not detected/);
  });

  it("detects user rejection", () => {
    assert.equal(classifyWalletError(new Error("User rejected the request"), "xbull").code, "rejected");
    assert.equal(classifyWalletError({ message: "The user closed the modal" }, "albedo").code, "rejected");
  });

  it("keeps unknown errors readable", () => {
    const err = classifyWalletError(new Error("boom"));
    assert.equal(err.code, "unknown");
    assert.equal(err.message, "boom");
  });
});

describe("connectionTypeFor", () => {
  it("maps each provider to its connection type", () => {
    assert.equal(connectionTypeFor("freighter"), "extension");
    assert.equal(connectionTypeFor("xbull"), "extension");
    assert.equal(connectionTypeFor("albedo"), "web");
    assert.equal(connectionTypeFor("wallet_connect"), "mobile");
  });
});

describe("ConnectWalletModalView", () => {
  it("lists all four supported providers as an accessible dialog", () => {
    const html = renderToStaticMarkup(<ConnectWalletModalView {...props()} />);
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    for (const name of ["Freighter", "Albedo", "xBull", "WalletConnect / LOBSTR"]) {
      assert.ok(html.includes(name), `missing ${name}`);
    }
  });

  it("offers an install link when an extension is not detected", () => {
    const html = renderToStaticMarkup(
      <ConnectWalletModalView
        {...props({
          wallets: [
            { id: "freighter", name: "Freighter", isAvailable: false },
            { id: "albedo", name: "Albedo", isAvailable: true },
          ],
        })}
      />
    );
    assert.match(html, /Not detected/);
    assert.match(html, /href="https:\/\/www\.freighter\.app\/"/);
  });

  it("marks WalletConnect as unconfigured when the kit does not provide it", () => {
    const html = renderToStaticMarkup(
      <ConnectWalletModalView {...props({ wallets: [{ id: "albedo", name: "Albedo", isAvailable: true }] })} />
    );
    assert.match(html, /Not configured for this deployment/);
  });

  it("shows the connected account and an error alert", () => {
    const key = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
    const html = renderToStaticMarkup(
      <ConnectWalletModalView
        {...props({
          selectedWallet: "freighter",
          publicKey: key,
          error: "Freighter connection was cancelled.",
          errorCode: "rejected",
        })}
      />
    );
    assert.match(html, /Freighter connected/);
    assert.match(html, /GABCDE\.\.\.STUVW|GABCDE\.\.\./);
    assert.match(html, /role="alert"/);
    assert.match(html, /connection was cancelled/);
  });
});
