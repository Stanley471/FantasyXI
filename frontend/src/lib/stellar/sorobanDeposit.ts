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
    const contractMatch = errMsg.match(/Error\(Contract,\s*#?(\d+)\)/i);
    if (contractMatch) {
      const code = parseInt(contractMatch[1], 10);
      switch (code) {
        case 6:
          throw new Error("You have already deposited for this league. Your entry is already confirmed!");
        case 5:
          throw new Error("This league is no longer accepting deposits (deadline locked or active).");
        case 4:
          throw new Error("The league escrow partition was not found on-chain.");
        case 7:
          throw new Error("This competition has already settled.");
        case 8:
          throw new Error("Invalid deposit amount specified.");
        case 10:
          throw new Error("Unauthorized: your account is not permitted to perform this action.");
        default:
          throw new Error(`Smart contract rejected deposit (Error #${code}).`);
      }
    }
    if (errMsg.toLowerCase().includes("balance") || errMsg.toLowerCase().includes("underfunded")) {
      throw new Error("Insufficient USDC balance or missing USDC trustline in your connected wallet.");
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
        const resultXdrStr = txStatus.resultXdr ? String(txStatus.resultXdr) : "";
        const contractMatch = resultXdrStr.match(/Error\(Contract,\s*#?(\d+)\)/i);
        let friendlyReason = "Soroban execution reverted on ledger.";
        if (contractMatch) {
          const code = parseInt(contractMatch[1], 10);
          if (code === 6) friendlyReason = "Deposit was already completed on-chain.";
          else if (code === 5) friendlyReason = "League deposit window has closed.";
          else if (code === 4) friendlyReason = "League partition not found.";
        }
        throw new Error(`Transaction failed on ledger: ${friendlyReason}`);
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

  onProgress?.("Transaction confirmed on-chain!");
  return {
    txHash,
    ledgerSeq: confirmedLedgerSeq,
  };
}
