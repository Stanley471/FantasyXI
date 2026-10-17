import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  WalletModalManager,
  SUPPORTED_WALLET_IDS,
  WALLET_STORAGE_KEY,
  WalletUserRejectedError,
  WalletModalClosedError,
  createSupportedWalletModules,
  type SupportedWalletId,
} from "../lib/stellar/walletModal.js";

// Mock localStorage for Node test environment
const mockStorage = new Map<string, string>();
const mockWindow = {
  localStorage: {
    getItem: (key: string) => mockStorage.get(key) || null,
    setItem: (key: string, val: string) => mockStorage.set(key, val),
    removeItem: (key: string) => mockStorage.delete(key),
    clear: () => mockStorage.clear(),
  },
};
Object.defineProperty(globalThis, "window", {
  value: mockWindow,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: mockWindow.localStorage,
  configurable: true,
});

function createMockKit() {
  let selectedWalletId = "";
  let activeNetwork = "TESTNET";
  let shouldRejectNextAction: "none" | "cancel" | "reject" | "close" = "none";

  return {
    init: (_params: Record<string, unknown>) => {},
    setWallet: (id: string) => {
      selectedWalletId = id;
    },
    setNetwork: (net: string) => {
      activeNetwork = net;
    },
    selectedModule: {
      get productId() {
        return selectedWalletId;
      },
    },
    fetchAddress: async () => {
      if (shouldRejectNextAction === "reject" || shouldRejectNextAction === "cancel") {
        throw new Error("User rejected wallet connection");
      }
      return { address: `G${selectedWalletId.toUpperCase().padEnd(55, "A")}` };
    },
    getAddress: async () => {
      return { address: `G${selectedWalletId.toUpperCase().padEnd(55, "A")}` };
    },
    signTransaction: async (xdr: string, _opts: Record<string, unknown>) => {
      if (shouldRejectNextAction === "reject") {
        throw new Error("User declined transaction signature");
      }
      return { signedTxXdr: `SIGNED_${xdr}_BY_${selectedWalletId.toUpperCase()}` };
    },
    disconnect: async () => {
      selectedWalletId = "";
    },
    authModal: async (_params: Record<string, unknown>) => {
      if (shouldRejectNextAction === "close") {
        return null;
      }
      if (shouldRejectNextAction === "reject" || shouldRejectNextAction === "cancel") {
        throw new Error("User cancelled modal selection");
      }
      selectedWalletId = selectedWalletId || "freighter";
      return { address: `G${selectedWalletId.toUpperCase().padEnd(55, "A")}` };
    },
    setRejectionMode: (mode: "none" | "cancel" | "reject" | "close") => {
      shouldRejectNextAction = mode;
    },
  };
}

describe("Stellar Multi-Wallet Connect Support (Issue #223)", () => {
  beforeEach(() => {
    mockStorage.clear();
  });

  it("configures all 4 supported Stellar wallet modules: Freighter, Albedo, xBull, and Hana", async () => {
    const modules = createSupportedWalletModules();
    const productIds = modules.map((m) => m.productId);

    assert.deepEqual(SUPPORTED_WALLET_IDS, ["freighter", "albedo", "xbull", "hana"]);
    assert.ok(productIds.includes("freighter"));
    assert.ok(productIds.includes("albedo"));
    assert.ok(productIds.includes("xbull"));
    assert.ok(productIds.includes("hana"));
  });

  it("provides Albedo web popup adapter without requiring browser extension installation", async () => {
    const mockKit = createMockKit();
    const manager = new WalletModalManager(mockKit);

    const wallets = await manager.getSupportedWallets();
    const albedo = wallets.find((w) => w.id === "albedo");

    assert.ok(albedo);
    assert.equal(albedo.type, "web");
    assert.equal(albedo.requiresExtension, false);
    assert.equal(albedo.isAvailable, true);
  });

  it("connects to each wallet type and persists provider in localStorage", async () => {
    for (const walletId of SUPPORTED_WALLET_IDS) {
      const mockKit = createMockKit();
      const manager = new WalletModalManager(mockKit);

      const res = await manager.connect(walletId);
      assert.equal(res.walletId, walletId);
      assert.ok(res.address.startsWith("G"));
      assert.equal(manager.getActiveWallet(), walletId);
      assert.equal(manager.getPersistedWallet(), walletId);
      assert.equal(mockStorage.get(WALLET_STORAGE_KEY), walletId);

      await manager.disconnect();
      assert.equal(manager.getActiveWallet(), null);
      assert.equal(manager.getPersistedWallet(), null);
      assert.equal(mockStorage.has(WALLET_STORAGE_KEY), false);
    }
  });

  it("signs transaction transparently across all configured wallet types", async () => {
    for (const walletId of SUPPORTED_WALLET_IDS) {
      const mockKit = createMockKit();
      const manager = new WalletModalManager(mockKit);

      await manager.connect(walletId);

      const sampleXdr = "AAAA...SAMPLE_XDR";
      const result = await manager.signTransaction(sampleXdr, {
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      assert.equal(
        result.signedTxXdr,
        `SIGNED_${sampleXdr}_BY_${walletId.toUpperCase()}`
      );
    }
  });

  it("properly handles error when user rejects wallet connection or signature", async () => {
    const mockKit = createMockKit();
    const manager = new WalletModalManager(mockKit);

    // Reject connection
    mockKit.setRejectionMode("reject");
    await assert.rejects(
      async () => manager.connect("freighter"),
      (err: unknown) => {
        assert.ok(err instanceof WalletUserRejectedError);
        assert.equal((err as WalletUserRejectedError).code, "CONNECTION_REJECTED");
        return true;
      }
    );

    // Reset and connect
    mockKit.setRejectionMode("none");
    await manager.connect("albedo");

    // Reject signature
    mockKit.setRejectionMode("reject");
    await assert.rejects(
      async () => manager.signTransaction("SAMPLE_XDR"),
      (err: unknown) => {
        assert.ok(err instanceof WalletUserRejectedError);
        assert.equal((err as WalletUserRejectedError).code, "SIGNATURE_REJECTED");
        return true;
      }
    );
  });

  it("properly handles error when user closes the wallet selection modal without selecting", async () => {
    const mockKit = createMockKit();
    const manager = new WalletModalManager(mockKit);

    mockKit.setRejectionMode("close");
    let closedCallbackFired = false;

    await assert.rejects(
      async () =>
        manager.openModal({
          onClosed: () => {
            closedCallbackFired = true;
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof WalletModalClosedError);
        assert.equal((err as WalletModalClosedError).code, "MODAL_CLOSED");
        return true;
      }
    );

    assert.equal(closedCallbackFired, true);
  });

  it("creates a compliant WalletAdapter for Soroban deposit workflows", async () => {
    const mockKit = createMockKit();
    const manager = new WalletModalManager(mockKit);

    const adapter = manager.createWalletAdapter("xbull");
    assert.equal(adapter.id, "xbull");

    await adapter.connect();
    const pubKey = await adapter.getPublicKey();
    assert.ok(pubKey.startsWith("G"));

    const signed = await adapter.signTransaction("MOCK_DEPOSIT_XDR", {
      networkPassphrase: "Test SDF Network ; September 2015",
      address: pubKey,
    });
    assert.equal(signed.signedTxXdr, "SIGNED_MOCK_DEPOSIT_XDR_BY_XBULL");

    await adapter.disconnect();
    assert.equal(manager.getActiveWallet(), null);
  });
});
