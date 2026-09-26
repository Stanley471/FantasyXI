/**
 * Frontend Soroban Escrow Deposit Helper
 *
 * Implements the canonical client-side Soroban deposit workflow:
 * 1. Wallet adapter connection & signing
 * 2. Building the Soroban invocation transaction: `deposit(participant, league_id)`
 * 3. Simulating/preparing the transaction via Soroban RPC
 * 4. Requesting user signature via Freighter (`signTransaction`)
 * 5. Submitting the signed transaction to Stellar Testnet
 * 6. Polling for on-chain confirmation and returning the transaction hash
 */

import {
  Address,
  Contract,
  nativeToScVal,
  Networks,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export interface DepositParams {
  escrowContractId: string;
  leagueId: number | string;
  userPublicKey: string;
  signTransaction: WalletTransactionSigner;
  rpcUrl?: string;
  networkPassphrase?: string;
  onProgress?: (status: string) => void;
}

export interface WalletAdapter {
  id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction: WalletTransactionSigner;
}

export type WalletTransactionSigner = (
  xdr: string,
  options: { networkPassphrase: string; address: string }
) => Promise<{ signedTxXdr: string }>;

export interface DepositResult {
  txHash: string;
  ledgerSeq?: number;
}

/**
 * Raised when a deposit was signed and submitted to the network but its final
 * status could not be confirmed before we stopped polling (RPC latency or a
 * dropped connection). The transaction may still succeed on-chain, so callers
 * must not treat this the same as a rejected or failed transaction: retrying
 * the deposit from scratch could double-spend. `txHash` lets the caller check
 * status again later (e.g. via a backend reconciliation endpoint) instead of
 * resubmitting.
 */
export class SorobanDepositTimeoutError extends Error {
  public readonly txHash: string;

  constructor(txHash: string) {
    super(
      "Your transaction was submitted but we could not confirm its status before timing out. " +
        "It may still succeed on-chain — click retry to check its status again."
    );
    this.name = "SorobanDepositTimeoutError";
    this.txHash = txHash;
  }
}

const DEFAULT_SOROBAN_RPC =
  process.env.NEXT_PUBLIC_STELLAR_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const DEFAULT_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;

/**
 * Builds, prepares, signs through the selected wallet, submits, and confirms a Soroban escrow deposit transaction.
 */
export async function depositToSorobanEscrow(
  params: DepositParams
): Promise<DepositResult> {
  const {
    escrowContractId,
    leagueId,
    userPublicKey,
    rpcUrl = DEFAULT_SOROBAN_RPC,
    networkPassphrase = DEFAULT_NETWORK_PASSPHRASE,
    onProgress,
    signTransaction: signWithWallet,
  } = params;

  if (!escrowContractId) {
    throw new Error("Escrow contract ID is required for deposit.");
  }
  if (!userPublicKey) {
    throw new Error("User public key is required for deposit.");
  }

  onProgress?.("Connecting to Stellar network...");
  const server = new rpc.Server(rpcUrl, { allowHttp: false });

  // 1. Fetch user account sequence from RPC
  onProgress?.("Fetching account sequence...");
  let account;
  try {
    account = await server.getAccount(userPublicKey);
  } catch {
    throw new Error(
      `Failed to load account ${userPublicKey}. Ensure your Testnet account is funded with XLM for gas fees.`
    );
  }

  // 2. Build the contract invocation operation
  onProgress?.("Building contract invocation...");
  const contract = new Contract(escrowContractId);

  // Convert league ID to u64 ScVal. League UUIDs map to their first 16 hex digits
  // (must match backend/src/services/financial/contractLeagueId.ts)
  let contractLeagueId: bigint;
  const uuidHex = String(leagueId).replace(/-/g, "").slice(0, 16);
  if (typeof leagueId === "string" && /^[0-9a-fA-F]{8}-/.test(leagueId)) {
    contractLeagueId = BigInt(`0x${uuidHex}`);
  } else {
    const numericLeagueId =
      typeof leagueId === "string" ? parseInt(leagueId, 10) : leagueId;
    if (isNaN(numericLeagueId) || numericLeagueId < 0) {
      throw new Error(`Invalid league ID for escrow: ${leagueId}`);
    }
    contractLeagueId = BigInt(numericLeagueId);
  }

  const depositOp = contract.call(
    "deposit",
    new Address(userPublicKey).toScVal(),
    nativeToScVal(contractLeagueId, { type: "u64" })
  );

  // 3. Build initial transaction
  const tx = new TransactionBuilder(account, {
    fee: "100000", // standard base fee (0.01 XLM max)
    networkPassphrase,
  })
    .addOperation(depositOp)
    .setTimeout(180)
    .build();

  // 4. Simulate and prepare transaction (fetches resource footprint, auth requirements, and Soroban fee)
  onProgress?.("Simulating transaction footprint...");
  let preparedTx;
  try {
    preparedTx = await server.prepareTransaction(tx);
  } catch (simErr: unknown) {
    const errMsg = simErr instanceof Error ? simErr.message : String(simErr);
    if (errMsg.includes("HostError") || errMsg.includes("Error(Contract")) {
      throw new Error(
        `Contract simulation rejected deposit. Ensure you have sufficient USDC balance and trustline. Details: ${errMsg}`
      );
    }
    throw new Error(`Transaction simulation failed: ${errMsg}`);
  }

  // 5. Request the selected wallet signature
  onProgress?.("Awaiting signature in your wallet...");
  let signedXdr: string;
  try {
    const signResult = await signWithWallet(preparedTx.toXDR(), {
      networkPassphrase,
      address: userPublicKey,
    });
    signedXdr = signResult.signedTxXdr;
  } catch (signErr: unknown) {
    const message = signErr instanceof Error ? signErr.message : String(signErr);
    throw new Error(
      message || "Signature request was rejected in the selected wallet."
    );
  }

  if (!signedXdr) {
    throw new Error("The selected wallet did not return a signed transaction.");
  }

  // 6. Submit transaction to Stellar network
  onProgress?.("Submitting transaction to Stellar Testnet...");
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const sendRes = await server.sendTransaction(signedTx);

  if (sendRes.status === "ERROR") {
    throw new Error(
      `Transaction submission error: ${JSON.stringify(sendRes.errorResult || sendRes)}`
    );
  }

  const txHash = sendRes.hash;

  // 7. Poll for confirmation
  onProgress?.("Confirming on Stellar ledger...");
  const maxAttempts = 24; // 24 * 2s = 48s max poll
  let attempts = 0;
  let confirmedLedgerSeq: number | undefined;

  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    attempts++;

    try {
      const txStatus = await server.getTransaction(txHash);
      if (txStatus.status === "SUCCESS") {
        confirmedLedgerSeq = txStatus.latestLedger;
        break;
      } else if (txStatus.status === "FAILED") {
        throw new Error(
          `Transaction failed on ledger. Soroban execution reverted: ${txStatus.resultXdr || "Check contract preconditions"}`
        );
      }
      // status is NOT_FOUND (pending) - keep polling
    } catch (pollErr: unknown) {
      const pollMessage = pollErr instanceof Error ? pollErr.message : String(pollErr);
      if (pollMessage.includes("reverted") || pollMessage.includes("failed on ledger")) {
        throw pollErr;
      }
      // Network hiccup during poll - continue
    }
  }

  if (confirmedLedgerSeq === undefined) {
    // Exhausted every poll attempt without a SUCCESS or FAILED status. The transaction
    // is still "in flight" from our perspective — do not report success, and do not let
    // the caller silently treat this as a confirmed deposit.
    throw new SorobanDepositTimeoutError(txHash);
  }

  onProgress?.("Transaction confirmed on-chain!");
  return {
    txHash,
    ledgerSeq: confirmedLedgerSeq,
  };
}
