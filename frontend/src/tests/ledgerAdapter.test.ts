import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  LedgerWalletAdapter,
  LedgerDeviceLockedError,
  LedgerAppNotOpenError,
  LedgerUserRejectedError,
  LedgerDeviceDisconnectedError,
  DEFAULT_BIP44_STELLAR_PATH,
} from "../lib/stellar/ledgerAdapter.js";
import {
  WalletModalManager,
  WALLET_STORAGE_KEY,
  WalletUserRejectedError,
} from "../lib/stellar/walletModal.js";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Account,
} from "@stellar/stellar-sdk";

// Mock localStorage for test environment
const mockStorage = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (key: string) => mockStorage.get(key) || null,
    setItem: (key: string, val: string) => mockStorage.set(key, val),
    removeItem: (key: string) => mockStorage.delete(key),
    clear: () => mockStorage.clear(),
  },
};
(globalThis as any).localStorage = (globalThis as any).window.localStorage;

function createMockLedgerTransport(options: {
  rejection?: "none" | "locked" | "app_not_open" | "user_rejected" | "disconnected";
  publicKey?: string;
  signatureHex?: string;
} = {}) {
  const dummyKeypair = Keypair.random();
  const pubKey = options.publicKey || dummyKeypair.publicKey();
  const signatureHex = options.signatureHex || "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
  let closed = false;

  const mockApp = {
    getPublicKey: async (path: string, boolValidate?: boolean) => {
      if (options.rejection === "locked") {
        const err: any = new Error("Device is locked");
        err.statusCode = 0x6b00;
        throw err;
      }
      if (options.rejection === "app_not_open") {
        const err: any = new Error("Stellar App not open");
        err.statusCode = 0x6e00;
        throw err;
      }
      if (options.rejection === "disconnected") {
        throw new Error("Cannot open device: USB connection disconnected");
      }
      if (options.rejection === "user_rejected") {
        const err: any = new Error("Condition of use not satisfied");
        err.statusCode = 0x6985;
        throw err;
      }
      return { publicKey: pubKey, address: pubKey };
    },
    signTransaction: async (path: string, signatureBase: Buffer) => {
      if (options.rejection === "user_rejected") {
        const err: any = new Error("Condition of use not satisfied");
        err.statusCode = 0x6985;
        throw err;
      }
      if (options.rejection === "disconnected") {
        throw new Error("Device disconnected mid-signature");
      }
      return { signature: Buffer.from(signatureHex, "hex") };
    },
  };

  const mockTransport = {
    close: async () => {
      closed = true;
    },
    send: async () => Buffer.from([]),
    isClosed: () => closed,
  };

  return { mockTransport, mockApp, pubKey, dummyKeypair };
}

function createDummyTxXdr(sourceKeypair: Keypair): string {
  const account = new Account(sourceKeypair.publicKey(), "1000");
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "5.0",
      })
    )
    .setTimeout(300)
    .build();

  return tx.toXDR();
}

describe("Ledger Hardware Wallet Transport Integration (Issue #355)", () => {
  beforeEach(() => {
    mockStorage.clear();
  });

  it("derives addresses using BIP-44 Stellar standard derivation path 44'/148'/0'", async () => {
    const { mockTransport, mockApp, pubKey } = createMockLedgerTransport();
    const adapter = new LedgerWalletAdapter({
      transportFactory: async () => mockTransport,
      appFactory: () => mockApp,
    });

    assert.equal(adapter.getDerivationPath(), DEFAULT_BIP44_STELLAR_PATH);
    assert.equal(LedgerWalletAdapter.getBip44Path(0), "44'/148'/0'");
    assert.equal(LedgerWalletAdapter.getBip44Path(1), "44'/148'/1'");

    const result = await adapter.connect();
    assert.equal(result.address, pubKey);
    assert.equal(result.derivationPath, "44'/148'/0'");
    assert.equal(adapter.getStatus(), "READY");

    await adapter.disconnect();
    assert.equal(adapter.getStatus(), "DISCONNECTED");
  });

  it("supports address visual verification on physical device screen", async () => {
    let verifiedOnDevice = false;
    const { mockTransport, mockApp, pubKey } = createMockLedgerTransport();
    mockApp.getPublicKey = async (_path: string, boolValidate?: boolean) => {
      if (boolValidate) {
        verifiedOnDevice = true;
      }
      return { publicKey: pubKey, address: pubKey };
    };

    const adapter = new LedgerWalletAdapter({
      transportFactory: async () => mockTransport,
      appFactory: () => mockApp,
    });

    const res = await adapter.getPublicKey(DEFAULT_BIP44_STELLAR_PATH, true);
    assert.equal(res.address, pubKey);
    assert.equal(verifiedOnDevice, true);
  });

  it("detects and raises LedgerDeviceLockedError when device is locked (0x6b00)", async () => {
    const { mockTransport, mockApp } = createMockLedgerTransport({ rejection: "locked" });
    const adapter = new LedgerWalletAdapter({
      transportFactory: async () => mockTransport,
      appFactory: () => mockApp,
    });

    await assert.rejects(
      async () => adapter.connect(),
      (err: any) => {
        assert.ok(err instanceof LedgerDeviceLockedError);
        assert.equal(err.code, "DEVICE_LOCKED");
        assert.ok(err.message.includes("unlock your device with your PIN"));
        return true;
      }
    );
  });

  it("detects and raises LedgerAppNotOpenError when Stellar app is closed (0x6e00)", async () => {
    const { mockTransport, mockApp } = createMockLedgerTransport({ rejection: "app_not_open" });
    const adapter = new LedgerWalletAdapter({
      transportFactory: async () => mockTransport,
      appFactory: () => mockApp,
    });

    await assert.rejects(
      async () => adapter.connect(),
      (err: any) => {
        assert.ok(err instanceof LedgerAppNotOpenError);
        assert.equal(err.code, "APP_NOT_OPEN");
        assert.ok(err.message.includes("open the Stellar app"));
        return true;
      }
    );
  });

  it("detects and raises LedgerDeviceDisconnectedError when device is disconnected", async () => {
    const { mockTransport, mockApp } = createMockLedgerTransport({ rejection: "disconnected" });
    const adapter = new LedgerWalletAdapter({
      transportFactory: async () => mockTransport,
      appFactory: () => mockApp,
    });

    await assert.rejects(
      async () => adapter.connect(),
      (err: any) => {
        assert.ok(err instanceof LedgerDeviceDisconnectedError);
        assert.equal(err.code, "DEVICE_DISCONNECTED");
        assert.ok(err.message.includes("Please check USB/HID cable"));
        return true;
      }
    );
  });

  it("detects and raises LedgerUserRejectedError when user rejects transaction signature on device (0x6985)", async () => {
    const { mockTransport, mockApp, dummyKeypair } = createMockLedgerTransport({
      rejection: "user_rejected",
    });
    const adapter = new LedgerWalletAdapter({
      transportFactory: async () => mockTransport,
      appFactory: () => mockApp,
    });

    const txXdr = createDummyTxXdr(dummyKeypair);
    await assert.rejects(
      async () => adapter.signTransaction(txXdr),
      (err: any) => {
        assert.ok(err instanceof LedgerUserRejectedError);
        assert.equal(err.code, "USER_REJECTED");
        assert.ok(err.message.includes("rejected on Ledger device"));
        return true;
      }
    );
  });

  it("signs transaction XDR on device and appends valid decorated signature", async () => {
    const { mockTransport, mockApp, dummyKeypair } = createMockLedgerTransport();
    const adapter = new LedgerWalletAdapter({
      transportFactory: async () => mockTransport,
      appFactory: () => mockApp,
    });

    await adapter.connect();

    const txXdr = createDummyTxXdr(dummyKeypair);
    const result = await adapter.signTransaction(txXdr, {
      networkPassphrase: Networks.TESTNET,
    });

    assert.ok(result.signedTxXdr);
    assert.notEqual(result.signedTxXdr, txXdr);

    // Verify signature was attached
    const parsedTx = TransactionBuilder.fromXDR(result.signedTxXdr, Networks.TESTNET) as any;
    assert.equal(parsedTx.signatures.length, 1);
  });

  it("integrates seamlessly into WalletModalManager alongside software wallets", async () => {
    const { mockTransport, mockApp, pubKey, dummyKeypair } = createMockLedgerTransport();
    const ledgerAdapter = new LedgerWalletAdapter({
      transportFactory: async () => mockTransport,
      appFactory: () => mockApp,
    });

    const manager = new WalletModalManager(null, ledgerAdapter);

    // Verify Ledger is included in supported wallets
    const wallets = await manager.getSupportedWallets();
    const ledgerInfo = wallets.find((w) => w.id === "ledger");
    assert.ok(ledgerInfo);
    assert.equal(ledgerInfo.type, "hardware");
    assert.equal(ledgerInfo.requiresExtension, false);

    // Connect to Ledger
    const conn = await manager.connect("ledger");
    assert.equal(conn.walletId, "ledger");
    assert.equal(conn.address, pubKey);
    assert.equal(manager.getActiveWallet(), "ledger");
    assert.equal(manager.getPersistedWallet(), "ledger");
    assert.equal(mockStorage.get(WALLET_STORAGE_KEY), "ledger");

    // Sign transaction through unified manager
    const txXdr = createDummyTxXdr(dummyKeypair);
    const signRes = await manager.signTransaction(txXdr, {
      networkPassphrase: Networks.TESTNET,
    });
    assert.ok(signRes.signedTxXdr);

    // Create WalletAdapter for deposit escrow
    const adapter = manager.createWalletAdapter("ledger");
    assert.equal(adapter.id, "ledger");
    const address = await adapter.getPublicKey();
    assert.equal(address, pubKey);

    // Disconnect
    await manager.disconnect();
    assert.equal(manager.getActiveWallet(), null);
    assert.equal(manager.getPersistedWallet(), null);
  });
});
