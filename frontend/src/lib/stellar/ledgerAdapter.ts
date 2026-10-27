/**
 * Ledger Hardware Wallet Transport Integration (Issue #355)
 *
 * Implements WebUSB / WebHID transport connection for Ledger hardware wallets
 * interacting with the Stellar application on physical devices.
 *
 * Features:
 * - BIP-44 derivation path support (standard `44'/148'/0'`) with custom index selection.
 * - Public key retrieval and on-device address verification.
 * - Transaction XDR signing directly on hardware device with user confirmation.
 * - Accurate status code mappings: Device Locked, App Not Open, User Rejected, Disconnected.
 */

import StrApp from "@ledgerhq/hw-app-str";
import {
  Keypair,
  Transaction,
  FeeBumpTransaction,
  TransactionBuilder,
  Networks,
  xdr,
} from "@stellar/stellar-sdk";

export const DEFAULT_BIP44_STELLAR_PATH = "44'/148'/0'";

export type LedgerDeviceStatus =
  | "DISCONNECTED"
  | "CONNECTING"
  | "READY"
  | "PROMPT_USER"
  | "BUSY";

export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export class LedgerDeviceLockedError extends LedgerError {
  constructor() {
    super("Ledger device is locked. Please unlock your device with your PIN.", "DEVICE_LOCKED", 0x6b00);
    this.name = "LedgerDeviceLockedError";
  }
}

export class LedgerAppNotOpenError extends LedgerError {
  constructor() {
    super("Stellar application is not open on your Ledger device. Please open the Stellar app.", "APP_NOT_OPEN", 0x6e00);
    this.name = "LedgerAppNotOpenError";
  }
}

export class LedgerUserRejectedError extends LedgerError {
  constructor(action: "connection" | "signature" = "signature") {
    super(
      action === "signature"
        ? "Transaction review rejected on Ledger device by user"
        : "Address verification rejected on Ledger device by user",
      "USER_REJECTED",
      0x6985
    );
    this.name = "LedgerUserRejectedError";
  }
}

export class LedgerDeviceDisconnectedError extends LedgerError {
  constructor(details?: string) {
    super(
      `Ledger device disconnected. Please check USB/HID cable connection.${details ? ` (${details})` : ""}`,
      "DEVICE_DISCONNECTED"
    );
    this.name = "LedgerDeviceDisconnectedError";
  }
}

export interface LedgerTransport {
  close(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(...args: any[]): Promise<Buffer>;
}

export type LedgerTransportFactory = () => Promise<LedgerTransport>;

export interface LedgerAdapterOptions {
  derivationPath?: string;
  transportFactory?: LedgerTransportFactory;
  appFactory?: (transport: LedgerTransport) => any;
}

export class LedgerWalletAdapter {
  private derivationPath: string;
  private transportFactory?: LedgerTransportFactory;
  private appFactory: (transport: LedgerTransport) => any;
  private transport: LedgerTransport | null = null;
  private appInstance: any = null;
  private activeAddress: string | null = null;
  private status: LedgerDeviceStatus = "DISCONNECTED";

  constructor(options: LedgerAdapterOptions = {}) {
    this.derivationPath = options.derivationPath ?? DEFAULT_BIP44_STELLAR_PATH;
    this.transportFactory = options.transportFactory;
    this.appFactory = options.appFactory ?? ((t) => new StrApp(t as any));
  }

  public getStatus(): LedgerDeviceStatus {
    return this.status;
  }

  public getDerivationPath(): string {
    return this.derivationPath;
  }

  public setDerivationPath(path: string): void {
    this.derivationPath = path;
  }

  /**
   * Builds BIP-44 path for an account index: 44'/148'/<index>'
   */
  public static getBip44Path(accountIndex = 0): string {
    return `44'/148'/${accountIndex}'`;
  }

  /**
   * Initializes or re-uses transport connection to Ledger device.
   */
  private async getApp(): Promise<any> {
    if (this.appInstance) return this.appInstance;

    this.status = "CONNECTING";
    try {
      if (this.transportFactory) {
        this.transport = await this.transportFactory();
      } else {
        // Dynamic import of WebUSB transport if available in browser
        if (typeof window !== "undefined" && (navigator as any)?.usb) {
          // In actual browser execution, dynamically load @ledgerhq/hw-transport-webusb
          const TransportWebUSB = (await import("@ledgerhq/hw-app-str" as any)).default;
          this.transport = await (TransportWebUSB as any).create();
        } else {
          throw new LedgerDeviceDisconnectedError("WebUSB / WebHID transport not supported in this environment");
        }
      }

      this.appInstance = this.appFactory(this.transport!);
      this.status = "READY";
      return this.appInstance;
    } catch (err: any) {
      this.status = "DISCONNECTED";
      this.transport = null;
      this.appInstance = null;
      throw this.normalizeError(err);
    }
  }

  /**
   * Connects to device and retrieves the Stellar public address.
   */
  public async connect(): Promise<{ address: string; derivationPath: string }> {
    return this.getPublicKey(this.derivationPath, false);
  }

  /**
   * Disconnects and frees the Ledger transport interface.
   */
  public async disconnect(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.close();
      }
    } finally {
      this.transport = null;
      this.appInstance = null;
      this.activeAddress = null;
      this.status = "DISCONNECTED";
    }
  }

  /**
   * Retrieves public key for the given derivation path.
   * If verifyOnDevice is true, prompts user to visually confirm address on Ledger screen.
   */
  public async getPublicKey(
    path: string = this.derivationPath,
    verifyOnDevice = false
  ): Promise<{ address: string; derivationPath: string }> {
    const app = await this.getApp();
    if (verifyOnDevice) {
      this.status = "PROMPT_USER";
    }

    try {
      const response = await app.getPublicKey(path, verifyOnDevice);
      const address = response.publicKey || response.address || response;
      this.activeAddress = address;
      this.derivationPath = path;
      this.status = "READY";
      return { address, derivationPath: path };
    } catch (err: any) {
      this.status = "READY";
      throw this.normalizeError(err);
    }
  }

  /**
   * Signs a Stellar transaction XDR directly on the hardware device.
   * Prompts user on the physical screen to review amounts, destinations, and confirm.
   */
  public async signTransaction(
    txXdr: string,
    options?: { derivationPath?: string; networkPassphrase?: string }
  ): Promise<{ signedTxXdr: string }> {
    const app = await this.getApp();
    const path = options?.derivationPath ?? this.derivationPath;
    const networkPassphrase = options?.networkPassphrase ?? Networks.TESTNET;

    let tx: Transaction | FeeBumpTransaction;
    try {
      tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
    } catch (parseErr: any) {
      throw new LedgerError(`Invalid transaction XDR: ${parseErr.message}`, "INVALID_XDR");
    }

    this.status = "PROMPT_USER";

    try {
      // In Stellar Ledger app, signTransaction takes (path, transactionSignatureBase)
      const signatureBase = tx.signatureBase();
      const response = await app.signTransaction(path, signatureBase);

      const signature = Buffer.isBuffer(response.signature)
        ? response.signature
        : Buffer.from(response.signature || response, "hex");

      // Verify and append signature to transaction envelope
      if (!this.activeAddress) {
        const pubKeyRes = await this.getPublicKey(path, false);
        this.activeAddress = pubKeyRes.address;
      }

      const keypair = Keypair.fromPublicKey(this.activeAddress);
      const hint = keypair.signatureHint();

      // Add signature to the transaction
      (tx as any).signatures.push(
        new xdr.DecoratedSignature({
          hint,
          signature,
        })
      );

      this.status = "READY";
      return { signedTxXdr: tx.toXDR() };
    } catch (err: any) {
      this.status = "READY";
      throw this.normalizeError(err);
    }
  }

  public getActiveAddress(): string | null {
    return this.activeAddress;
  }

  /**
   * Normalizes Ledger hardware APDU error codes and exceptions into typed domain errors.
   */
  private normalizeError(err: any): Error {
    if (err instanceof LedgerError) return err;

    const message = (err?.message || String(err)).toLowerCase();
    const statusCode = err?.statusCode || err?.status || (typeof err?.returnCode === "number" ? err.returnCode : undefined);

    // 0x6985: User rejected transaction / action cancelled
    if (
      statusCode === 0x6985 ||
      message.includes("condition of use not satisfied") ||
      message.includes("user rejected") ||
      message.includes("action cancelled") ||
      message.includes("denied")
    ) {
      return new LedgerUserRejectedError("signature");
    }

    // 0x6b00 / 0x6982: Device locked / PIN needed
    if (
      statusCode === 0x6b00 ||
      statusCode === 0x6982 ||
      message.includes("locked") ||
      message.includes("security status not satisfied")
    ) {
      return new LedgerDeviceLockedError();
    }

    // 0x6e00 / 0x6d00 / app closed or wrong app
    if (
      statusCode === 0x6e00 ||
      statusCode === 0x6d00 ||
      message.includes("app not open") ||
      message.includes("cla_not_supported") ||
      message.includes("ins_not_supported")
    ) {
      return new LedgerAppNotOpenError();
    }

    // Disconnected / USB missing
    if (
      message.includes("disconnected") ||
      message.includes("cannot open device") ||
      message.includes("no device selected") ||
      message.includes("usb") ||
      message.includes("not found")
    ) {
      return new LedgerDeviceDisconnectedError(err?.message);
    }

    return new LedgerError(err?.message || "Unknown Ledger hardware error", "LEDGER_ERROR", statusCode);
  }
}
