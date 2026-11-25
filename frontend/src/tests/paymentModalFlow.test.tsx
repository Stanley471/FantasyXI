import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentModal } from "../components/leagues/PaymentModal";
import { WalletContext } from "../context/WalletContext";

const mockWallet = {
  wallets: [],
  selectedWallet: "freighter" as const,
  connectionType: "extension" as const,
  publicKey: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
  isConnecting: false,
  connectingWalletId: null,
  isReady: true,
  error: null,
  errorCode: null,
  isConnectModalOpen: false,
  openConnectModal: () => {},
  closeConnectModal: () => {},
  connect: async () => {},
  disconnect: async () => {},
  signTransaction: async (xdr: string) => xdr,
  adapter: null,
};

describe("PaymentModal & Stellar SAC Branding (Issues #542, #543)", () => {
  it("renders Soroban escrow deposit controls and strictly excludes legacy Polar or Zcash options", () => {
    const html = renderToStaticMarkup(
      <WalletContext.Provider value={mockWallet}>
        <PaymentModal
          isOpen={true}
          onClose={() => {}}
          leagueId="league-123"
          leagueName="Premier Soroban League"
          squadId="squad-456"
          entryFee={25}
        />
      </WalletContext.Provider>
    );

    // Verifies Stellar / Soroban escrow UI elements are present
    assert.match(html, /Soroban Escrow Deposit/i);
    assert.match(html, /Required Entry Fee/i);
    assert.match(html, /25 USDC/i);
    assert.match(html, /Stellar Testnet/i);
    assert.match(html, /Non-custodial Soroban escrow/i);

    // Guarantees zero mentions of legacy multi-chain deposit rails
    assert.doesNotMatch(html, /zcash/i);
    assert.doesNotMatch(html, /pollar/i);
    assert.doesNotMatch(html, /polar/i);
    assert.doesNotMatch(html, /\bzec\b/i);
  });

  it("does not render when isOpen is false", () => {
    const html = renderToStaticMarkup(
      <WalletContext.Provider value={mockWallet}>
        <PaymentModal
          isOpen={false}
          onClose={() => {}}
          leagueId="league-123"
          leagueName="Premier Soroban League"
          squadId="squad-456"
          entryFee={25}
        />
      </WalletContext.Provider>
    );

    assert.equal(html, "");
  });
});
