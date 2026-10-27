/**
 * Soroban Contract State Archival Recovery & Persistent Storage Rent Monitor
 *
 * Implements:
 * 1. Periodic TTL inspection of escrow contract instances and storage entries via Soroban RPC.
 * 2. Automated generation and execution of extendFootprintTtl and restoreFootprint transactions.
 * 3. Contract rent reserve telemetry alerting when reserves fall below minimum safe balances.
 */

import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  LocalSecretTransactionSigner,
  type StellarTransactionSigner,
} from "./transactionSigner.js";
import {
  AdminAlertNotifier,
  adminAlertNotifier as defaultAdminAlertNotifier,
} from "../notifications/adminAlertNotifier.js";

export type EntryTtlStatus = "HEALTHY" | "NEEDS_EXTEND" | "ARCHIVED";

export interface InspectedLedgerEntry {
  keyXdr: string;
  contractId?: string;
  liveUntilLedgerSeq?: number;
  currentLedgerSeq: number;
  remainingTtlLedgers: number;
  status: EntryTtlStatus;
  lastModifiedLedgerSeq?: number;
}

export interface RentReserveStatus {
  contractAddress: string;
  balanceStroops: bigint;
  balanceXlm: string;
  minSafeBalanceStroops: bigint;
  isSafe: boolean;
  alertEmitted: boolean;
}

export interface ArchivalRecoveryReport {
  timestamp: Date;
  currentLedger: number;
  inspectedEntries: InspectedLedgerEntry[];
  entriesNeedingExtend: InspectedLedgerEntry[];
  entriesNeedingRestore: InspectedLedgerEntry[];
  extendedCount: number;
  restoredCount: number;
  extendTxHashes: string[];
  restoreTxHashes: string[];
  rentReserveStatuses: RentReserveStatus[];
  errors: string[];
}

export interface SorobanArchivalRecoveryOptions {
  rpcUrl?: string;
  networkPassphrase?: string;
  server?: rpc.Server;
  signer?: StellarTransactionSigner;
  alertNotifier?: AdminAlertNotifier;
  escrowContractId?: string;
  warnThresholdLedgers?: number;
  restoreThresholdLedgers?: number;
  extendTtlLedgers?: number;
  minSafeBalanceStroops?: bigint;
}

export class SorobanStateArchivalRecoveryService {
  private server: rpc.Server;
  private networkPassphrase: string;
  private signer: StellarTransactionSigner;
  private alertNotifier: AdminAlertNotifier;
  private escrowContractId: string;

  // Configurable thresholds
  public readonly warnThresholdLedgers: number;
  public readonly restoreThresholdLedgers: number;
  public readonly extendTtlLedgers: number;
  public readonly minSafeBalanceStroops: bigint;

  constructor(options: SorobanArchivalRecoveryOptions = {}) {
    const rpcUrl =
      options.rpcUrl ||
      process.env.STELLAR_SOROBAN_RPC_URL ||
      "https://soroban-testnet.stellar.org";

    this.server =
      options.server ||
      new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

    this.networkPassphrase =
      options.networkPassphrase ||
      process.env.STELLAR_NETWORK_PASSPHRASE ||
      Networks.TESTNET;

    this.signer = options.signer || new LocalSecretTransactionSigner();
    this.alertNotifier = options.alertNotifier || defaultAdminAlertNotifier;

    this.escrowContractId =
      options.escrowContractId ||
      process.env.STELLAR_ESCROW_CONTRACT_ID ||
      "";

    // Threshold configs via env or defaults
    // 17,280 ledgers ~= 24 hours at 5s / ledger
    this.warnThresholdLedgers =
      options.warnThresholdLedgers ??
      Number(process.env.SOROBAN_TTL_WARN_THRESHOLD_LEDGERS || "17280");

    // 1,000 ledgers ~= critical near-expiry / restore zone
    this.restoreThresholdLedgers =
      options.restoreThresholdLedgers ??
      Number(process.env.SOROBAN_TTL_RESTORE_THRESHOLD_LEDGERS || "1000");

    // Default extend by 518,400 ledgers (~30 days)
    this.extendTtlLedgers =
      options.extendTtlLedgers ??
      Number(process.env.SOROBAN_EXTEND_TTL_LEDGERS || "518400");

    // Default safe rent reserve: 10 XLM = 100,000,000 stroops
    this.minSafeBalanceStroops =
      options.minSafeBalanceStroops ??
      BigInt(process.env.SOROBAN_MIN_SAFE_BALANCE_STROOPS || "100000000");
  }

  /**
   * Helper to derive the contract instance LedgerKey for a given contract address.
   */
  public getContractInstanceLedgerKey(contractId: string): xdr.LedgerKey {
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      })
    );
  }

  /**
   * Evaluates the health status of a ledger entry based on remaining TTL.
   */
  public evaluateTtlStatus(
    remainingTtl: number
  ): EntryTtlStatus {
    if (remainingTtl <= this.restoreThresholdLedgers) {
      return "ARCHIVED";
    }
    if (remainingTtl <= this.warnThresholdLedgers) {
      return "NEEDS_EXTEND";
    }
    return "HEALTHY";
  }

  /**
   * Inspects entry TTLs for specified contract IDs and custom ledger keys.
   */
  public async inspectContractEntries(
    contractIds: string[] = [],
    customKeys: xdr.LedgerKey[] = []
  ): Promise<{ currentLedger: number; entries: InspectedLedgerEntry[] }> {
    const targetContracts = [...contractIds];
    if (targetContracts.length === 0 && this.escrowContractId) {
      targetContracts.push(this.escrowContractId);
    }

    const keysToQuery: xdr.LedgerKey[] = [...customKeys];
    for (const cid of targetContracts) {
      try {
        keysToQuery.push(this.getContractInstanceLedgerKey(cid));
      } catch (err) {
        console.warn(`[archival-recovery] Invalid contract ID: ${cid}`);
      }
    }

    if (keysToQuery.length === 0) {
      return { currentLedger: 0, entries: [] };
    }

    const latestLedgerResp = await this.server.getLatestLedger();
    const currentLedger = latestLedgerResp.sequence;

    const entriesResult: InspectedLedgerEntry[] = [];
    const response = await this.server.getLedgerEntries(...keysToQuery);

    const queriedEntries = response.entries || [];
    const returnedKeysMap = new Map<string, (typeof queriedEntries)[0]>();

    for (const entry of queriedEntries) {
      const keyXdr =
        typeof entry.key === "string"
          ? entry.key
          : (entry.key as unknown as { toXDR(format: string): string }).toXDR("base64");
      returnedKeysMap.set(keyXdr, entry);
    }

    for (let i = 0; i < keysToQuery.length; i++) {
      const rawKey = keysToQuery[i];
      const keyBase64 = rawKey.toXDR("base64");
      const matched = returnedKeysMap.get(keyBase64);

      if (!matched) {
        // Entry not found on ledger -> treat as ARCHIVED
        entriesResult.push({
          keyXdr: keyBase64,
          contractId: i < targetContracts.length ? targetContracts[i] : undefined,
          liveUntilLedgerSeq: undefined,
          currentLedgerSeq: currentLedger,
          remainingTtlLedgers: 0,
          status: "ARCHIVED",
        });
        continue;
      }

      const liveUntil = matched.liveUntilLedgerSeq;
      const remainingTtl =
        liveUntil !== undefined ? Math.max(0, liveUntil - currentLedger) : 0;
      const status = this.evaluateTtlStatus(remainingTtl);

      entriesResult.push({
        keyXdr: keyBase64,
        contractId: i < targetContracts.length ? targetContracts[i] : undefined,
        liveUntilLedgerSeq: liveUntil,
        currentLedgerSeq: currentLedger,
        remainingTtlLedgers: remainingTtl,
        status,
        lastModifiedLedgerSeq: matched.lastModifiedLedgerSeq,
      });
    }

    return { currentLedger, entries: entriesResult };
  }

  /**
   * Builds and submits an Operation.extendFootprintTtl transaction for the specified keys.
   */
  public async extendFootprintTtl(
    sourceSecret: string,
    keys: xdr.LedgerKey[],
    extendByLedgers?: number
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (keys.length === 0) {
      return { success: true };
    }

    try {
      const extendAmount = extendByLedgers ?? this.extendTtlLedgers;
      const latestLedger = await this.server.getLatestLedger();
      const extendTo = latestLedger.sequence + extendAmount;

      const sourcePublicKey = await this.signer.publicKey(sourceSecret);
      const account = await this.server.getAccount(sourcePublicKey);

      const op = Operation.extendFootprintTtl({
        extendTo,
      });

      // Construct transaction with SorobanData footprint
      const footprint = new xdr.LedgerFootprint({
        readOnly: keys,
        readWrite: [],
      });
      const resources = new xdr.SorobanResources({
        footprint,
        instructions: 200_000,
        diskReadBytes: 4096,
        writeBytes: 0,
      });
      const sorobanData = new xdr.SorobanTransactionData({
        ext: xdr.ExtensionPoint.v0(),
        resources,
        resourceFee: 100_000n as any,
      });

      const tx = new TransactionBuilder(account, {
        fee: (Number(BASE_FEE) + 100_000).toString(),
        networkPassphrase: this.networkPassphrase,
      })
        .setSorobanData(sorobanData)
        .addOperation(op)
        .setTimeout(30)
        .build();

      // Simulate to obtain actual resources and fee
      const simulation = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulation)) {
        return { success: false, error: `Simulation failed: ${simulation.error}` };
      }

      const assembled = rpc.assembleTransaction(tx, simulation).build();
      await this.signer.sign(assembled, sourceSecret);

      const sendResponse = await this.server.sendTransaction(assembled);
      if (sendResponse.status === "ERROR") {
        return {
          success: false,
          error: `Submission failed: ${JSON.stringify(sendResponse.errorResult)}`,
        };
      }

      const hash = sendResponse.hash;
      await this.pollUntilFinal(hash);

      return { success: true, txHash: hash };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Builds and submits an Operation.restoreFootprint transaction for archived keys.
   */
  public async restoreFootprint(
    sourceSecret: string,
    keys: xdr.LedgerKey[]
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (keys.length === 0) {
      return { success: true };
    }

    try {
      const sourcePublicKey = await this.signer.publicKey(sourceSecret);
      const account = await this.server.getAccount(sourcePublicKey);

      const op = Operation.restoreFootprint({});

      const footprint = new xdr.LedgerFootprint({
        readOnly: [],
        readWrite: keys,
      });
      const resources = new xdr.SorobanResources({
        footprint,
        instructions: 300_000,
        diskReadBytes: 4096,
        writeBytes: 4096,
      });
      const sorobanData = new xdr.SorobanTransactionData({
        ext: xdr.ExtensionPoint.v0(),
        resources,
        resourceFee: 200_000n as any,
      });

      const tx = new TransactionBuilder(account, {
        fee: (Number(BASE_FEE) + 200_000).toString(),
        networkPassphrase: this.networkPassphrase,
      })
        .setSorobanData(sorobanData)
        .addOperation(op)
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulation)) {
        return { success: false, error: `Simulation failed: ${simulation.error}` };
      }

      const assembled = rpc.assembleTransaction(tx, simulation).build();
      await this.signer.sign(assembled, sourceSecret);

      const sendResponse = await this.server.sendTransaction(assembled);
      if (sendResponse.status === "ERROR") {
        return {
          success: false,
          error: `Submission failed: ${JSON.stringify(sendResponse.errorResult)}`,
        };
      }

      const hash = sendResponse.hash;
      await this.pollUntilFinal(hash);

      return { success: true, txHash: hash };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Inspects rent reserves / native balances of contract addresses and emits alerts if deficient.
   */
  public async inspectRentReserves(
    contractAddresses: string[]
  ): Promise<RentReserveStatus[]> {
    const statuses: RentReserveStatus[] = [];

    for (const address of contractAddresses) {
      try {
        let balanceStroops = 0n;
        try {
          const account = await this.server.getAccount(address);
          for (const b of (account as unknown as { balances?: Array<{ asset_type: string; balance: string }> }).balances || []) {
            if (b.asset_type === "native") {
              balanceStroops = BigInt(Math.round(parseFloat(b.balance) * 10_000_000));
            }
          }
        } catch {
          // If contract is not a standard account, query balance using zero or fall back
          balanceStroops = 0n;
        }

        const isSafe = balanceStroops >= this.minSafeBalanceStroops;
        let alertEmitted = false;

        const balanceXlm = (Number(balanceStroops) / 10_000_000).toFixed(4);

        if (!isSafe) {
          alertEmitted = true;
          await this.alertNotifier.notify({
            title: `Low Contract Rent Reserve: ${address}`,
            severity: "warning",
            text: `Contract ${address} rent reserve is critically low: ${balanceXlm} XLM (Safe minimum: ${(Number(this.minSafeBalanceStroops) / 10_000_000).toFixed(4)} XLM). Storage entries risk archival!`,
          });
        }

        statuses.push({
          contractAddress: address,
          balanceStroops,
          balanceXlm,
          minSafeBalanceStroops: this.minSafeBalanceStroops,
          isSafe,
          alertEmitted,
        });
      } catch (err) {
        console.error("[archival-recovery] Failed inspecting reserve for %s:", address, err);
      }
    }

    return statuses;
  }

  /**
   * Executes a full monitoring and automated recovery cycle.
   */
  public async runRecoveryCycle(
    sourceSecret: string,
    contractIds: string[] = []
  ): Promise<ArchivalRecoveryReport> {
    const targetContracts = [...contractIds];
    if (targetContracts.length === 0 && this.escrowContractId) {
      targetContracts.push(this.escrowContractId);
    }

    const { currentLedger, entries } = await this.inspectContractEntries(targetContracts);

    const needingExtend = entries.filter((e) => e.status === "NEEDS_EXTEND");
    const needingRestore = entries.filter((e) => e.status === "ARCHIVED");

    const extendTxHashes: string[] = [];
    const restoreTxHashes: string[] = [];
    const errors: string[] = [];

    // Automatically extend expiring entries
    if (needingExtend.length > 0) {
      const keysToExtend = needingExtend.map((e) =>
        xdr.LedgerKey.fromXDR(e.keyXdr, "base64")
      );
      const extendRes = await this.extendFootprintTtl(
        sourceSecret,
        keysToExtend,
        this.extendTtlLedgers
      );
      if (extendRes.success && extendRes.txHash) {
        extendTxHashes.push(extendRes.txHash);
      } else if (extendRes.error) {
        errors.push(`Extend TTL failed: ${extendRes.error}`);
      }
    }

    // Automatically restore archived entries
    if (needingRestore.length > 0) {
      const keysToRestore = needingRestore.map((e) =>
        xdr.LedgerKey.fromXDR(e.keyXdr, "base64")
      );
      const restoreRes = await this.restoreFootprint(sourceSecret, keysToRestore);
      if (restoreRes.success && restoreRes.txHash) {
        restoreTxHashes.push(restoreRes.txHash);
      } else if (restoreRes.error) {
        errors.push(`Restore footprint failed: ${restoreRes.error}`);
      }
    }

    // Inspect rent reserves
    const rentReserveStatuses = await this.inspectRentReserves(targetContracts);

    return {
      timestamp: new Date(),
      currentLedger,
      inspectedEntries: entries,
      entriesNeedingExtend: needingExtend,
      entriesNeedingRestore: needingRestore,
      extendedCount: needingExtend.length,
      restoredCount: needingRestore.length,
      extendTxHashes,
      restoreTxHashes,
      rentReserveStatuses,
      errors,
    };
  }

  private async pollUntilFinal(hash: string): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const tx = await this.server.getTransaction(hash);
      if (tx.status === "SUCCESS") return;
      if (tx.status === "FAILED") {
        throw new Error(`Transaction ${hash} failed on-chain`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
