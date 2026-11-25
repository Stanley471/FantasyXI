import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MultiChainWalletSessionManager,
  WalletSessionError,
  buildClientLinkChallenge,
  extractChallengeMetadata,
  MULTICHAIN_SESSION_STORAGE_KEY,
  type BrowserWalletProviderAdapter,
  type StorageLike,
} from "../lib/wallet/multiChainLinker";

function createMemoryStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function createControllableAdapter(params: {
  chain: "EVM" | "STELLAR" | "ZCASH";
  providerName: string;
  initialAddress: string;
  initialNetworkId: string;
}) {
  let currentAddress = params.initialAddress;
  let currentNetworkId = params.initialNetworkId;
  let rejectConnection = false;
  let rejectSignature = false;

  const accountListeners = new Set<(accounts: string[]) => void>();
  const chainListeners = new Set<(networkId: string) => void>();
  const disconnectListeners = new Set<(reason?: string) => void>();

  const adapter: BrowserWalletProviderAdapter = {
    chain: params.chain,
    providerName: params.providerName,
    connect: async () => {
      if (rejectConnection) {
        throw new Error("User rejected wallet connection request");
      }
      return { address: currentAddress, networkId: currentNetworkId };
    },
    silentReconnect: async () => {
      if (rejectConnection) return null;
      return { address: currentAddress, networkId: currentNetworkId };
    },
    disconnect: async () => {},
    signMessage: async (message: string, address: string) => {
      if (rejectSignature) {
        throw new Error("User declined message signature");
      }
      return `sig_${params.chain}_${address}_${message.length}`;
    },
    onAccountsChanged: (cb) => {
      accountListeners.add(cb);
      return () => accountListeners.delete(cb);
    },
    onChainChanged: (cb) => {
      chainListeners.add(cb);
      return () => chainListeners.delete(cb);
    },
    onDisconnect: (cb) => {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    },
  };

  return {
    adapter,
    setRejectConnection: (val: boolean) => {
      rejectConnection = val;
    },
    setRejectSignature: (val: boolean) => {
      rejectSignature = val;
    },
    emitAccountSwitch: (accounts: string[]) => {
      currentAddress = accounts[0] ?? "";
      for (const cb of accountListeners) cb(accounts);
    },
    emitNetworkSwitch: (nextNetworkId: string) => {
      currentNetworkId = nextNetworkId;
      for (const cb of chainListeners) cb(nextNetworkId);
    },
    emitConnectionLoss: (reason?: string) => {
      for (const cb of disconnectListeners) cb(reason);
    },
  };
}

describe("Multi-Chain Wallet Linker & Connection Recovery (Issue #426)", () => {
  let storage: ReturnType<typeof createMemoryStorage>;
  let manager: MultiChainWalletSessionManager;

  beforeEach(() => {
    storage = createMemoryStorage();
    manager = new MultiChainWalletSessionManager({ storage });
  });

  it("formats EIP-4361 and SEP-0010 challenges with timestamp and nonce and blocks replay attacks", () => {
    const userId = "manager-001";
    const evmAddr = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const stellarAddr = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
    const zcashAddr = "t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs";

    const evmChal = buildClientLinkChallenge({
      userId,
      chain: "EVM",
      address: evmAddr,
      networkId: "eip155:1",
      nonce: "nonce_evm_12345",
      nowMs: 1_700_000_000_000,
    });
    assert.equal(evmChal.standard, "EIP-4361");
    assert.equal(extractChallengeMetadata(evmChal.message).nonce, "nonce_evm_12345");
    assert.equal(extractChallengeMetadata(evmChal.message).isEip4361OrSep0010, true);

    const stellarChal = buildClientLinkChallenge({
      userId,
      chain: "STELLAR",
      address: stellarAddr,
      networkId: "TESTNET",
      nonce: "nonce_stellar_67890",
      nowMs: 1_700_000_000_000,
    });
    assert.equal(stellarChal.standard, "SEP-0010");
    assert.equal(extractChallengeMetadata(stellarChal.message).nonce, "nonce_stellar_67890");
    assert.equal(extractChallengeMetadata(stellarChal.message).isEip4361OrSep0010, true);

    const zcashChal = buildClientLinkChallenge({
      userId,
      chain: "ZCASH",
      address: zcashAddr,
      networkId: "mainnet",
      nonce: "nonce_zcash_99999",
      nowMs: 1_700_000_000_000,
    });

    // Link all three chains to the unified FantasyXI identity
    const linkedEvm = manager.verifyAndLinkAddress(
      {
        userId,
        chain: "EVM",
        address: evmAddr,
        providerName: "MetaMask",
        label: "Primary EVM",
        networkId: "eip155:1",
        challengeMessage: evmChal.message,
        signature: "0xabcdef1234567890abcdef1234567890",
      },
      1_700_000_005_000
    );
    assert.equal(linkedEvm.isPrimary, true);

    manager.verifyAndLinkAddress(
      {
        userId,
        chain: "STELLAR",
        address: stellarAddr,
        providerName: "Freighter",
        label: "Soroban Wallet",
        networkId: "TESTNET",
        challengeMessage: stellarChal.message,
        signature: "stellar_signature_base64_valid_payload",
      },
      1_700_000_006_000
    );

    manager.verifyAndLinkAddress(
      {
        userId,
        chain: "ZCASH",
        address: zcashAddr,
        providerName: "Zashi",
        label: "Zcash Shielded",
        networkId: "mainnet",
        challengeMessage: zcashChal.message,
        signature: "zcash_signature_valid_payload_12345",
      },
      1_700_000_007_000
    );

    assert.equal(manager.listLinkedWallets(userId).length, 3);

    // Replaying the previously signed EVM challenge must be blocked
    assert.throws(
      () =>
        manager.verifyAndLinkAddress(
          {
            userId,
            chain: "EVM",
            address: evmAddr,
            providerName: "MetaMask",
            label: "Replay Attempt",
            networkId: "eip155:1",
            challengeMessage: evmChal.message,
            signature: "0xabcdef1234567890abcdef1234567890",
          },
          1_700_000_010_000
        ),
      (err: unknown) => err instanceof WalletSessionError && err.code === "REPLAY_BLOCKED"
    );

    // Another user attempting to link the already claimed EVM address is blocked
    const otherChal = buildClientLinkChallenge({
      userId: "manager-002",
      chain: "EVM",
      address: evmAddr,
      networkId: "eip155:1",
      nonce: "fresh_nonce_for_user2",
      nowMs: 1_700_000_010_000,
    });

    assert.throws(
      () =>
        manager.verifyAndLinkAddress(
          {
            userId: "manager-002",
            chain: "EVM",
            address: evmAddr,
            providerName: "MetaMask",
            label: "Hijack Attempt",
            networkId: "eip155:1",
            challengeMessage: otherChal.message,
            signature: "0x99999999999999999999999999999999",
          },
          1_700_000_015_000
        ),
      (err: unknown) =>
        err instanceof WalletSessionError && err.code === "ADDRESS_ALREADY_CLAIMED"
    );
  });

  it("handles connection rejection, connection loss, account switching, and silent reconnection", async () => {
    const evmControl = createControllableAdapter({
      chain: "EVM",
      providerName: "MetaMask",
      initialAddress: "0x1111111111111111111111111111111111111111",
      initialNetworkId: "eip155:1",
    });
    manager.registerAdapter(evmControl.adapter);

    // 1. User rejects connection request
    evmControl.setRejectConnection(true);
    await assert.rejects(
      () => manager.connectProvider("user-1", "EVM", "MetaMask"),
      (err: unknown) => err instanceof WalletSessionError && err.code === "CONNECTION_REJECTED"
    );
    assert.equal(manager.getStatus().connectionState, "ERROR");

    // 2. Successful connection persists session
    evmControl.setRejectConnection(false);
    const connected = await manager.connectProvider("user-1", "EVM", "MetaMask");
    assert.equal(connected.address, "0x1111111111111111111111111111111111111111");
    assert.equal(manager.getStatus().connectionState, "CONNECTED");
    assert.ok(storage.getItem(MULTICHAIN_SESSION_STORAGE_KEY));

    // 3. Account switching in browser extension updates active address and storage
    evmControl.emitAccountSwitch(["0x2222222222222222222222222222222222222222"]);
    assert.equal(
      manager.getStatus().activeAddress,
      "0x2222222222222222222222222222222222222222"
    );
    assert.equal(manager.getStatus().connectionState, "CONNECTED");

    // 4. Automatic silent reconnection in a fresh session manager instance
    const recoveredManager = new MultiChainWalletSessionManager({ storage });
    recoveredManager.registerAdapter(evmControl.adapter);
    const reconnected = await recoveredManager.attemptSilentReconnect();
    assert.equal(reconnected, true);
    assert.equal(recoveredManager.getStatus().connectionState, "CONNECTED");
    assert.equal(
      recoveredManager.getStatus().activeAddress,
      "0x2222222222222222222222222222222222222222"
    );

    // 5. Connection loss clears session and transitions to DISCONNECTED
    evmControl.emitConnectionLoss("Extension background process terminated");
    assert.equal(recoveredManager.getStatus().connectionState, "DISCONNECTED");
    assert.equal(recoveredManager.getStatus().activeAddress, null);
    assert.match(recoveredManager.getStatus().lastError ?? "", /terminated/);
    assert.equal(storage.getItem(MULTICHAIN_SESSION_STORAGE_KEY), null);
  });

  it("prompts user when active network switches in browser extension and gracefully updates UI state", async () => {
    const evmControl = createControllableAdapter({
      chain: "EVM",
      providerName: "MetaMask",
      initialAddress: "0x3333333333333333333333333333333333333333",
      initialNetworkId: "eip155:1",
    });
    manager.registerAdapter(evmControl.adapter);

    await manager.connectProvider("user-net", "EVM", "MetaMask");
    assert.equal(manager.getStatus().activeNetworkId, "eip155:1");

    // Browser extension switches chain from Ethereum Mainnet (eip155:1) to Base (eip155:8453)
    evmControl.emitNetworkSwitch("eip155:8453");

    const pendingStatus = manager.getStatus();
    assert.equal(pendingStatus.connectionState, "NETWORK_SWITCH_PENDING");
    assert.ok(pendingStatus.networkSwitchPrompt);
    assert.equal(pendingStatus.networkSwitchPrompt.previousNetworkId, "eip155:1");
    assert.equal(pendingStatus.networkSwitchPrompt.requestedNetworkId, "eip155:8453");
    assert.equal(pendingStatus.networkSwitchPrompt.requiresConfirmation, true);

    // User confirms the network switch prompt
    manager.acknowledgeNetworkSwitch(true);
    const confirmedStatus = manager.getStatus();
    assert.equal(confirmedStatus.connectionState, "CONNECTED");
    assert.equal(confirmedStatus.activeNetworkId, "eip155:8453");
    assert.equal(confirmedStatus.networkSwitchPrompt, null);

    // Extension switches to an unwanted chain; user declines the switch prompt
    evmControl.emitNetworkSwitch("eip155:999999");
    assert.equal(manager.getStatus().connectionState, "NETWORK_SWITCH_PENDING");
    manager.acknowledgeNetworkSwitch(false);
    assert.equal(manager.getStatus().connectionState, "DISCONNECTED");
    assert.equal(manager.getStatus().activeAddress, null);
  });
});
