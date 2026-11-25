import {
  Address,
  Contract,
  nativeToScVal,
  Networks,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { SimulationServer } from "./sorobanDeposit";

export interface WalletTransactionSigner {
  (
    xdr: string,
    options?: {
      networkPassphrase?: string;
      address?: string;
    }
  ): Promise<{ signedTxXdr: string }>;
}

export interface ClaimPrizeParams {
  escrowContractId: string;
  leagueId: number | string;
  winnerPublicKey: string;
  signTransaction: WalletTransactionSigner;
  rpcUrl?: string;
  networkPassphrase?: string;
  onProgress?: (status: string) => void;
  server?: SimulationServer;
}

export interface ClaimPrizeResult {
  txHash: string;
  ledger: number;
}

const DEFAULT_SOROBAN_RPC =
  process.env.NEXT_PUBLIC_STELLAR_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const DEFAULT_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;

export function mapClaimError(errMsg: string): string {
  const contractMatch = errMsg.match(/Error\(Contract,\s*#?(\d+)\)/i);
  if (contractMatch) {
    const code = parseInt(contractMatch[1], 10);
    switch (code) {
      case 13:
        return "No claimable prize found for this address in this competition.";
      case 24:
        return "Prize has already been claimed for this address.";
      case 4:
        return "League escrow partition was not found on-chain.";
      case 10:
        return "Unauthorized: caller address does not match winner account.";
      case 14:
        return "Claim operations are temporarily halted while the escrow contract is paused.";
      default:
        return `Escrow contract rejected claim (Error #${code}).`;
    }
  }
  const lower = errMsg.toLowerCase();
  if (lower.includes("not paused") || lower.includes("notpaused")) {
    return "Contract state error occurred during claim.";
  }
  return `Claim simulation failed: ${errMsg}`;
}

export function parseContractLeagueId(leagueId: number | string): bigint {
  const uuidHex = String(leagueId).replace(/-/g, "").slice(0, 16);
  if (typeof leagueId === "string" && /^[0-9a-fA-F]{8}-/.test(leagueId)) {
    return BigInt(`0x${uuidHex}`);
  }
  const numericLeagueId =
    typeof leagueId === "string" ? parseInt(leagueId, 10) : leagueId;
  if (isNaN(numericLeagueId) || numericLeagueId < 0) {
    throw new Error(`Invalid league ID for escrow: ${leagueId}`);
  }
  return BigInt(numericLeagueId);
}

/**
 * Builds, prepares, signs through wallet, submits, and confirms a Soroban claim_prize transaction.
 */
export async function claimPrizeFromSorobanEscrow(
  params: ClaimPrizeParams
): Promise<ClaimPrizeResult> {
  const {
    escrowContractId,
    leagueId,
    winnerPublicKey,
    rpcUrl = DEFAULT_SOROBAN_RPC,
    networkPassphrase = DEFAULT_NETWORK_PASSPHRASE,
    onProgress,
    signTransaction: signWithWallet,
  } = params;

  if (!escrowContractId) {
    throw new Error("Escrow contract ID is required for prize claim.");
  }
  if (!winnerPublicKey) {
    throw new Error("Winner public key is required for prize claim.");
  }

  onProgress?.("Connecting to Stellar network...");
  const server: SimulationServer =
    params.server ?? new rpc.Server(rpcUrl, { allowHttp: false });

  onProgress?.("Fetching account sequence...");
  let account;
  try {
    account = await server.getAccount(winnerPublicKey);
  } catch {
    throw new Error(
      `Failed to load account ${winnerPublicKey}. Ensure your account is funded with XLM for gas fees.`
    );
  }

  onProgress?.("Building contract invocation...");
  const contract = new Contract(escrowContractId);
  const contractLeagueId = parseContractLeagueId(leagueId);

  const claimOp = contract.call(
    "claim_prize",
    new Address(winnerPublicKey).toScVal(),
    nativeToScVal(contractLeagueId, { type: "u64" })
  );

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase,
  })
    .addOperation(claimOp)
    .setTimeout(180)
    .build();

  onProgress?.("Simulating transaction footprint...");
  let sim;
  try {
    sim = await server.simulateTransaction(tx);
  } catch (err: unknown) {
    throw new Error(mapClaimError(err instanceof Error ? err.message : String(err)));
  }

  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(mapClaimError(sim.error));
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new Error("Contract state has expired and must be restored before claiming.");
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error("Transaction simulation did not return a successful result.");
  }

  const preparedTx = rpc.assembleTransaction(tx, sim).build();

  onProgress?.("Awaiting signature in your wallet...");
  let signedXdr: string;
  try {
    const signResult = await signWithWallet(preparedTx.toXDR(), {
      networkPassphrase,
      address: winnerPublicKey,
    });
    signedXdr = signResult.signedTxXdr;
  } catch (signErr: unknown) {
    const message = signErr instanceof Error ? signErr.message : String(signErr);
    throw new Error(message || "Signature request was rejected in your wallet.");
  }

  if (!signedXdr) {
    throw new Error("The wallet did not return a signed transaction.");
  }

  onProgress?.("Submitting transaction to Stellar network...");
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const sendRes = await server.sendTransaction(signedTx);

  if (sendRes.status === "ERROR") {
    throw new Error(
      `Transaction submission error: ${JSON.stringify(sendRes.errorResult || sendRes)}`
    );
  }

  const txHash = sendRes.hash;
  onProgress?.("Confirming transaction on-chain...");

  const maxAttempts = 12;
  const pollIntervalMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    try {
      const txStatus = await server.getTransaction(txHash);
      if (txStatus.status === "SUCCESS") {
        return {
          txHash,
          ledger: txStatus.ledger ?? 0,
        };
      }
      if (txStatus.status === "FAILED") {
        throw new Error("Claim transaction failed during ledger execution.");
      }
    } catch (pollErr: unknown) {
      if (
        pollErr instanceof Error &&
        pollErr.message.includes("failed during ledger execution")
      ) {
        throw pollErr;
      }
    }
  }

  return { txHash, ledger: 0 };
}
