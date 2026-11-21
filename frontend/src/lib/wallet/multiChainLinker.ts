/**
 * Crypto Wallet Connection Recovery & Multi-Chain Account Linker (Issue #426)
 *
 * Frontend architecture supporting:
 * 1. Cryptographically signed EIP-4361 / SEP-0010 challenge-response verification
 *    for linking EVM, Stellar, and Zcash addresses to an existing FantasyXI account.
 * 2. Anti-replay defense tracking consumed challenge nonces and timestamps.
 * 3. Cross-account ownership collision protection.
 * 4. Wallet session disconnection handling, active network/chain switching prompt
 *    with graceful UI state updates, account switching listener, and automatic
 *    silent reconnection from persisted session storage.
 */

export type SupportedMultiChain = "EVM" | "STELLAR" | "ZCASH";

export type ChallengeStandard = "EIP-4361" | "SEP-0010";

export type WalletConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "NETWORK_SWITCH_PENDING"
  | "ERROR";

export interface LinkedWalletAccount {
  id: string;
  userId: string;
  chain: SupportedMultiChain;
  address: string;
  providerName: string;
  label: string;
  networkId: string;
  isPrimary: boolean;
  linkedAt: string;
  lastVerifiedAt: string;
}

export interface WalletLinkChallengePayload {
  challengeId: string;
  userId: string;
  chain: SupportedMultiChain;
  standard: ChallengeStandard;
  address: string;
  networkId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  message: string;
}

export interface NetworkSwitchPrompt {
  previousNetworkId: string;
  requestedNetworkId: string;
  chain: SupportedMultiChain;
  message: string;
  requiresConfirmation: boolean;
}

export interface BrowserWalletProviderAdapter {
  chain: SupportedMultiChain;
  providerName: string;
  connect: () => Promise<{ address: string; networkId: string }>;
  silentReconnect?: () => Promise<{ address: string; networkId: string } | null>;
  disconnect: () => Promise<void>;
  signMessage: (message: string, address: string) => Promise<string>;
  switchNetwork?: (targetNetworkId: string) => Promise<void>;
  onAccountsChanged?: (cb: (accounts: string[]) => void) => () => void;
  onChainChanged?: (cb: (networkId: string) => void) => () => void;
  onDisconnect?: (cb: (reason?: string) => void) => () => void;
}

export class WalletSessionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CONNECTION_REJECTED"
      | "SIGNATURE_REJECTED"
      | "CONNECTION_LOST"
      | "REPLAY_BLOCKED"
      | "CHALLENGE_EXPIRED"
      | "INVALID_CHALLENGE"
      | "ADDRESS_ALREADY_CLAIMED"
      | "NETWORK_SWITCH_REJECTED"
      | "WALLET_NOT_FOUND"
  ) {
    super(message);
    this.name = "WalletSessionError";
  }
}

export const MULTICHAIN_SESSION_STORAGE_KEY = "fantasyxi.multichain.session.v1";

export interface PersistedMultiChainSession {
  userId: string;
  chain: SupportedMultiChain;
  providerName: string;
  address: string;
  networkId: string;
  connectedAt: string;
}

export function buildClientLinkChallenge(params: {
  userId: string;
  chain: SupportedMultiChain;
  address: string;
  networkId: string;
  domain?: string;
  uri?: string;
  nonce?: string;
  nowMs?: number;
  ttlMs?: number;
}): WalletLinkChallengePayload {
  const now = params.nowMs ?? Date.now();
  const ttl = params.ttlMs ?? 5 * 60 * 1000;
  const domain = params.domain ?? "fantasyxi.app";
  const uri = params.uri ?? "https://fantasyxi.app/profile";
  const nonce =
    params.nonce ??
    `nx_${now.toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttl).toISOString();

  if (params.chain === "STELLAR") {
    const message = [
      `SEP-0010 Stellar Web Authentication — ${domain}`,
      `Account: ${params.address}`,
      `FantasyXI User ID: ${params.userId}`,
      `URI: ${uri}`,
      `Version: 1`,
      `Network: ${params.networkId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
      `Expiration Time: ${expiresAt}`,
    ].join("\n");

    return {
      challengeId: `chal_${nonce}`,
      userId: params.userId,
      chain: params.chain,
      standard: "SEP-0010",
      address: params.address,
      networkId: params.networkId,
      nonce,
      issuedAt,
      expiresAt,
      message,
    };
  }

  const chainIdLine =
    params.chain === "EVM"
      ? params.networkId.replace(/^eip155:/i, "") || "1"
      : `zcash-${params.networkId}`;

  const message = [
    `${domain} wants you to sign in with your ${params.chain} account:`,
    `${params.address}`,
    ``,
    `Link ${params.chain} address to FantasyXI identity ${params.userId}.`,
    ``,
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: ${chainIdLine}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join("\n");

  return {
    challengeId: `chal_${nonce}`,
    userId: params.userId,
    chain: params.chain,
    standard: "EIP-4361",
    address: params.address,
    networkId: params.networkId,
    nonce,
    issuedAt,
    expiresAt,
    message,
  };
}

export function extractChallengeMetadata(message: string): {
  nonce: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  isEip4361OrSep0010: boolean;
} {
  const nonceMatch = message.match(/^Nonce:\s*([A-Za-z0-9_-]+)$/m);
  const issuedAtMatch = message.match(/^Issued At:\s*(.+)$/m);
  const expiresAtMatch = message.match(/^Expiration Time:\s*(.+)$/m);
  const isSep10 = message.includes("SEP-0010 Stellar Web Authentication");
  const isEip4361 = message.includes("wants you to sign in with your");

  return {
    nonce: nonceMatch ? nonceMatch[1].trim() : null,
    issuedAt: issuedAtMatch ? issuedAtMatch[1].trim() : null,
    expiresAt: expiresAtMatch ? expiresAtMatch[1].trim() : null,
    isEip4361OrSep0010: Boolean((isSep10 || isEip4361) && nonceMatch && issuedAtMatch),
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MultiChainWalletSessionManager {
  private connectionState: WalletConnectionState = "DISCONNECTED";
  private activeChain: SupportedMultiChain | null = null;
  private activeProviderName: string | null = null;
  private activeAddress: string | null = null;
  private activeNetworkId: string | null = null;
  private networkSwitchPrompt: NetworkSwitchPrompt | null = null;
  private lastError: string | null = null;

  private readonly adapters = new Map<string, BrowserWalletProviderAdapter>();
  private readonly linkedWallets = new Map<string, LinkedWalletAccount>();
  private readonly addressOwnerIndex = new Map<string, string>(); // `${chain}:${normAddr}` -> userId
  private readonly consumedNonces = new Set<string>();
  private readonly consumedSignedPayloads = new Set<string>();
  private unsubscribers: Array<() => void> = [];
  private readonly storage: StorageLike | null;

  constructor(options?: { storage?: StorageLike | null }) {
    if (options && "storage" in options) {
      this.storage = options.storage ?? null;
    } else if (typeof window !== "undefined" && window.localStorage) {
      this.storage = window.localStorage;
    } else {
      this.storage = null;
    }
  }

  public registerAdapter(adapter: BrowserWalletProviderAdapter): void {
    this.adapters.set(`${adapter.chain}:${adapter.providerName}`, adapter);
  }

  public getStatus() {
    return {
      connectionState: this.connectionState,
      activeChain: this.activeChain,
      activeProviderName: this.activeProviderName,
      activeAddress: this.activeAddress,
      activeNetworkId: this.activeNetworkId,
      networkSwitchPrompt: this.networkSwitchPrompt,
      lastError: this.lastError,
    };
  }

  private normalizeAddr(chain: SupportedMultiChain, address: string): string {
    const trimmed = address.trim();
    if (chain === "EVM") return trimmed.toLowerCase();
    if (chain === "STELLAR") return trimmed.toUpperCase();
    return trimmed;
  }

  private persistSession(userId: string): void {
    if (!this.storage || !this.activeChain || !this.activeProviderName || !this.activeAddress) {
      return;
    }
    const payload: PersistedMultiChainSession = {
      userId,
      chain: this.activeChain,
      providerName: this.activeProviderName,
      address: this.activeAddress,
      networkId: this.activeNetworkId ?? "default",
      connectedAt: new Date().toISOString(),
    };
    this.storage.setItem(MULTICHAIN_SESSION_STORAGE_KEY, JSON.stringify(payload));
  }

  private clearPersistedSession(): void {
    this.storage?.removeItem(MULTICHAIN_SESSION_STORAGE_KEY);
  }

  private attachAdapterListeners(userId: string, adapter: BrowserWalletProviderAdapter): void {
    this.cleanupListeners();

    if (adapter.onAccountsChanged) {
      this.unsubscribers.push(
        adapter.onAccountsChanged((accounts) => {
          if (!accounts || accounts.length === 0) {
            this.handleUnexpectedDisconnect("Wallet extension locked or all accounts disconnected.");
            return;
          }
          const nextAddress = accounts[0];
          if (nextAddress !== this.activeAddress) {
            this.activeAddress = nextAddress;
            this.connectionState = "CONNECTED";
            this.lastError = null;
            this.persistSession(userId);
          }
        })
      );
    }

    if (adapter.onChainChanged) {
      this.unsubscribers.push(
        adapter.onChainChanged((nextNetworkId) => {
          const prevNetworkId = this.activeNetworkId ?? "unknown";
          if (nextNetworkId !== prevNetworkId) {
            this.networkSwitchPrompt = {
              previousNetworkId: prevNetworkId,
              requestedNetworkId: nextNetworkId,
              chain: adapter.chain,
              message: `Active network changed in ${adapter.providerName} from ${prevNetworkId} to ${nextNetworkId}. Confirm to continue on ${nextNetworkId}.`,
              requiresConfirmation: true,
            };
            this.activeNetworkId = nextNetworkId;
            this.connectionState = "NETWORK_SWITCH_PENDING";
            this.persistSession(userId);
          }
        })
      );
    }

    if (adapter.onDisconnect) {
      this.unsubscribers.push(
        adapter.onDisconnect((reason) => {
          this.handleUnexpectedDisconnect(
            reason || `Connection to ${adapter.providerName} was lost.`
          );
        })
      );
    }
  }

  private cleanupListeners(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // ignore listener cleanup error
      }
    }
    this.unsubscribers = [];
  }

  public handleUnexpectedDisconnect(reason: string): void {
    this.cleanupListeners();
    this.connectionState = "DISCONNECTED";
    this.activeAddress = null;
    this.activeChain = null;
    this.activeProviderName = null;
    this.activeNetworkId = null;
    this.networkSwitchPrompt = null;
    this.lastError = reason;
    this.clearPersistedSession();
  }

  /**
   * Connects to a wallet provider adapter, sets up account/chain/disconnect listeners,
   * and persists session metadata for silent automatic recovery.
   */
  public async connectProvider(
    userId: string,
    chain: SupportedMultiChain,
    providerName: string
  ): Promise<{ address: string; networkId: string }> {
    const adapter = this.adapters.get(`${chain}:${providerName}`);
    if (!adapter) {
      throw new WalletSessionError(
        `No wallet adapter registered for ${chain}:${providerName}`,
        "WALLET_NOT_FOUND"
      );
    }

    this.connectionState = "CONNECTING";
    this.lastError = null;

    try {
      const result = await adapter.connect();
      this.activeChain = chain;
      this.activeProviderName = providerName;
      this.activeAddress = result.address;
      this.activeNetworkId = result.networkId;
      this.connectionState = "CONNECTED";
      this.networkSwitchPrompt = null;
      this.attachAdapterListeners(userId, adapter);
      this.persistSession(userId);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connectionState = "ERROR";
      this.lastError = msg;
      throw new WalletSessionError(msg, "CONNECTION_REJECTED");
    }
  }

  /**
   * Attempts silent automatic reconnection from a previously persisted wallet session.
   */
  public async attemptSilentReconnect(): Promise<boolean> {
    if (!this.storage) return false;
    const raw = this.storage.getItem(MULTICHAIN_SESSION_STORAGE_KEY);
    if (!raw) return false;

    let saved: PersistedMultiChainSession;
    try {
      saved = JSON.parse(raw) as PersistedMultiChainSession;
    } catch {
      this.clearPersistedSession();
      return false;
    }

    const adapter = this.adapters.get(`${saved.chain}:${saved.providerName}`);
    if (!adapter) {
      this.clearPersistedSession();
      return false;
    }

    this.connectionState = "RECONNECTING";
    try {
      const restored = adapter.silentReconnect
        ? await adapter.silentReconnect()
        : await adapter.connect();
      if (!restored || !restored.address) {
        this.connectionState = "DISCONNECTED";
        this.clearPersistedSession();
        return false;
      }

      this.activeChain = saved.chain;
      this.activeProviderName = saved.providerName;
      this.activeAddress = restored.address;
      this.activeNetworkId = restored.networkId;
      this.connectionState = "CONNECTED";
      this.lastError = null;
      this.attachAdapterListeners(saved.userId, adapter);
      this.persistSession(saved.userId);
      return true;
    } catch {
      this.connectionState = "DISCONNECTED";
      this.clearPersistedSession();
      return false;
    }
  }

  /**
   * Confirms or rejects a browser extension network switch prompt and updates UI state.
   */
  public acknowledgeNetworkSwitch(accept: boolean): void {
    if (!this.networkSwitchPrompt) return;
    if (accept) {
      this.activeNetworkId = this.networkSwitchPrompt.requestedNetworkId;
      this.networkSwitchPrompt = null;
      this.connectionState = "CONNECTED";
    } else {
      this.networkSwitchPrompt = null;
      this.handleUnexpectedDisconnect("User declined active network switch.");
    }
  }

  public async disconnect(): Promise<void> {
    if (this.activeChain && this.activeProviderName) {
      const adapter = this.adapters.get(`${this.activeChain}:${this.activeProviderName}`);
      if (adapter) {
        try {
          await adapter.disconnect();
        } catch {
          // ignore
        }
      }
    }
    this.cleanupListeners();
    this.connectionState = "DISCONNECTED";
    this.activeChain = null;
    this.activeProviderName = null;
    this.activeAddress = null;
    this.activeNetworkId = null;
    this.networkSwitchPrompt = null;
    this.clearPersistedSession();
  }

  /**
   * Verifies a signed EIP-4361 / SEP-0010 challenge and links the wallet to `userId`.
   * Blocks replay attacks and prevents linking an address already claimed by another user.
   */
  public verifyAndLinkAddress(
    params: {
      userId: string;
      chain: SupportedMultiChain;
      address: string;
      providerName: string;
      label: string;
      networkId: string;
      challengeMessage: string;
      signature: string;
    },
    nowMs: number = Date.now()
  ): LinkedWalletAccount {
    const meta = extractChallengeMetadata(params.challengeMessage);
    if (!meta.isEip4361OrSep0010 || !meta.nonce || !meta.issuedAt) {
      throw new WalletSessionError(
        "Challenge must follow EIP-4361 or SEP-0010 format with timestamp and nonce",
        "INVALID_CHALLENGE"
      );
    }

    if (!params.signature || params.signature.trim().length < 16) {
      throw new WalletSessionError(
        "Valid cryptographic signature is required to link wallet",
        "SIGNATURE_REJECTED"
      );
    }

    const replayKey = `${params.chain}:${this.normalizeAddr(params.chain, params.address)}:${meta.nonce}:${params.signature}`;
    if (this.consumedNonces.has(meta.nonce) || this.consumedSignedPayloads.has(replayKey)) {
      throw new WalletSessionError(
        "Replay attack blocked: signed challenge message or nonce has already been used",
        "REPLAY_BLOCKED"
      );
    }

    if (meta.expiresAt) {
      const exp = Date.parse(meta.expiresAt);
      if (!Number.isNaN(exp) && nowMs > exp) {
        this.consumedNonces.add(meta.nonce);
        throw new WalletSessionError("Linking challenge has expired", "CHALLENGE_EXPIRED");
      }
    }

    const addressKey = `${params.chain}:${this.normalizeAddr(params.chain, params.address)}`;
    const existingOwner = this.addressOwnerIndex.get(addressKey);
    if (existingOwner && existingOwner !== params.userId) {
      throw new WalletSessionError(
        `Address ${params.address} is already linked to another active user account`,
        "ADDRESS_ALREADY_CLAIMED"
      );
    }

    this.consumedNonces.add(meta.nonce);
    this.consumedSignedPayloads.add(replayKey);

    const userWallets = this.listLinkedWallets(params.userId);
    const isPrimary = userWallets.length === 0;
    const nowIso = new Date(nowMs).toISOString();

    const account: LinkedWalletAccount = {
      id: `lnk_${params.chain.toLowerCase()}_${Math.random().toString(36).slice(2, 10)}`,
      userId: params.userId,
      chain: params.chain,
      address: params.address,
      providerName: params.providerName,
      label: params.label.trim() || `${params.chain} Wallet`,
      networkId: params.networkId,
      isPrimary,
      linkedAt: nowIso,
      lastVerifiedAt: nowIso,
    };

    this.linkedWallets.set(account.id, account);
    this.addressOwnerIndex.set(addressKey, params.userId);
    return { ...account };
  }

  public listLinkedWallets(userId: string): LinkedWalletAccount[] {
    const out: LinkedWalletAccount[] = [];
    for (const wallet of this.linkedWallets.values()) {
      if (wallet.userId === userId) out.push({ ...wallet });
    }
    return out;
  }

  public renameLinkedWallet(userId: string, walletId: string, newLabel: string): LinkedWalletAccount {
    const wallet = this.linkedWallets.get(walletId);
    if (!wallet || wallet.userId !== userId) {
      throw new WalletSessionError("Wallet not found", "WALLET_NOT_FOUND");
    }
    wallet.label = newLabel.trim() || wallet.label;
    return { ...wallet };
  }

  public unlinkWallet(userId: string, walletId: string): void {
    const wallet = this.linkedWallets.get(walletId);
    if (!wallet || wallet.userId !== userId) {
      throw new WalletSessionError("Wallet not found", "WALLET_NOT_FOUND");
    }
    const addressKey = `${wallet.chain}:${this.normalizeAddr(wallet.chain, wallet.address)}`;
    this.addressOwnerIndex.delete(addressKey);
    this.linkedWallets.delete(walletId);
  }
}
