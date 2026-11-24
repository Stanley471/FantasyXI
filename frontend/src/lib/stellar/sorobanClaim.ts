/**
 * Frontend Soroban Escrow Prize Claim Architecture (Issue #546)
 *
 * Implements trustless, non-custodial pull-over-push prize claims from the Soroban
 * escrow contract.
 *
 * Winners invoke `claim_prize(winner, league_id)` on the deployed contract, which
 * verifies winner authorization, transfers tokens directly from contract custody
 * to the winner's wallet, and purges the claimable entry to strictly prevent double-claims.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Networks,
  rpc,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export interface ClaimPrizeParams {
  escrowContractId: string;
  leagueId: number | string;
  winnerPublicKey: string;
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  rpcUrl?: string;
  networkPassphrase?: string;
  onProgress?: (status: string) => void;
  server?: any;
}

export interface ClaimPrizeResult {
  success: boolean;
  txHash: string;
  leagueId: string;
  winnerAddress: string;
  ledgerSeq?: number;
}

export class SorobanClaimError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "SorobanClaimError";
  }
}

/**
 * Maps raw RPC or contract errors to user-friendly UI messages.
 */
export function mapClaimErrorToMessage(err: unknown): string {
  if (!err) return "An unknown error occurred while claiming prize.";
  const msg = err instanceof Error ? err.message : String(err);

  if (/user declined|rejected by user|signature rejected/i.test(msg)) {
    return "Signature request was rejected in your wallet.";
  }
  if (/NoClaimablePrize|no claimable/i.test(msg)) {
    return "No claimable prize found. You may not be an authorized winner or the prize has already been claimed.";
  }
  if (/ContractPaused|paused/i.test(msg)) {
    return "The escrow contract is currently paused. Please try again later.";
  }
  if (/LeagueNotFound/i.test(msg)) {
    return "League escrow not found on-chain.";
  }
  if (/NetworkError|failed to fetch|could not reach/i.test(msg)) {
    return "Could not reach the Stellar network. Check your connection and retry.";
  }

  return msg;
}

/**
 * Builds the unsigned Soroban transaction invoking `claim_prize(winner, league_id)`.
 */
export function buildClaimPrizeTx(
  account: any,
  escrowContractId: string,
  leagueId: number | string,
  winnerPublicKey: string,
  networkPassphrase: string = Networks.TESTNET
): Transaction {
  const contract = new Contract(escrowContractId);
  const numericLeagueId = BigInt(leagueId);

  const operation = contract.call(
    "claim_prize",
    Address.fromString(winnerPublicKey).toScVal(),
    nativeToScVal(numericLeagueId, { type: "u64" })
  );

  return new TransactionBuilder(account, {
    fee: (100 * parseInt(BASE_FEE, 10)).toString(),
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();
}

/**
 * Executes the complete claim prize workflow:
 * 1. Simulates invocation via Soroban RPC
 * 2. Prepares footprint and transaction fees
 * 3. Requests wallet signature from Freighter
 * 4. Submits transaction to Stellar Testnet
 * 5. Polls for confirmation
 */
export async function claimEscrowPrize(params: ClaimPrizeParams): Promise<ClaimPrizeResult> {
  const {
    escrowContractId,
    leagueId,
    winnerPublicKey,
    signTransaction,
    rpcUrl = "https://soroban-testnet.stellar.org",
    networkPassphrase = Networks.TESTNET,
    onProgress = () => {},
  } = params;

  const server = params.server ?? new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

  onProgress("Loading account sequence from Stellar network...");
  let account: any;
  try {
    account = await server.getAccount(winnerPublicKey);
  } catch (err) {
    throw new SorobanClaimError(
      `Failed to load account ${winnerPublicKey}. Ensure your account is funded with XLM for transaction fees.`,
      "ACCOUNT_NOT_FOUND"
    );
  }

  onProgress("Simulating prize claim on Soroban contract...");
  const rawTx = buildClaimPrizeTx(account, escrowContractId, leagueId, winnerPublicKey, networkPassphrase);

  let simulation: any;
  try {
    simulation = await server.simulateTransaction(rawTx);
  } catch (err) {
    throw new SorobanClaimError(`Simulation request failed: ${(err as Error).message}`, "SIMULATION_FAILED");
  }

  if (rpc.Api.isSimulationError(simulation)) {
    throw new SorobanClaimError(
      `Contract simulation rejected claim: ${simulation.error}`,
      "SIMULATION_REJECTED"
    );
  }

  onProgress("Preparing transaction footprint...");
  const preparedTx =
    typeof server.assembleTransaction === "function"
      ? server.assembleTransaction(rawTx, simulation)
      : rpc.assembleTransaction(rawTx, simulation).build();

  onProgress("Requesting wallet signature...");
  let signedXdr: string;
  try {
    signedXdr = await signTransaction(preparedTx.toXDR(), { networkPassphrase });
  } catch (err) {
    if (err instanceof SorobanClaimError) throw err;
    throw new SorobanClaimError(
      mapClaimErrorToMessage(err),
      "SIGNATURE_REJECTED"
    );
  }

  onProgress("Broadcasting prize claim to Stellar network...");
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;
  const sendResponse = await server.sendTransaction(signedTx);

  if (sendResponse.status === "ERROR") {
    throw new SorobanClaimError(
      `Transaction submission failed: ${JSON.stringify(sendResponse.errorResult)}`,
      "SUBMISSION_ERROR"
    );
  }

  const txHash = sendResponse.hash;
  onProgress(`Transaction submitted (${txHash.slice(0, 8)}...). Waiting for ledger confirmation...`);

  let finalLedger: number | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    const txStatus = await server.getTransaction(txHash);
    if (txStatus.status === "SUCCESS") {
      finalLedger = txStatus.latestLedger;
      break;
    }
    if (txStatus.status === "FAILED") {
      throw new SorobanClaimError(
        `On-chain execution failed for transaction ${txHash}`,
        "EXECUTION_FAILED"
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  onProgress("Prize claimed successfully!");
  return {
    success: true,
    txHash,
    leagueId: String(leagueId),
    winnerAddress: winnerPublicKey,
    ledgerSeq: finalLedger,
  };
}
