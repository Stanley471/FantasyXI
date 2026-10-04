/**
 * Soroban Error Handling, Diagnostics, and State Recovery
 *
 * Provides typed decoding, human-friendly translation, retry policies,
 * and transactional rollback mechanisms for Soroban smart contract interactions.
 */

import { xdr } from "@stellar/stellar-sdk";

export enum EscrowContractErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  LeagueAlreadyExists = 3,
  LeagueNotFound = 4,
  LeagueNotAcceptingDeposits = 5,
  AlreadyDeposited = 6,
  AlreadySettled = 7,
  InvalidAmount = 8,
  PayoutExceedsDeposits = 9,
  NotAuthorized = 10,
  FeeExceedsMaxCap = 11,
  InvalidPrizeDistribution = 12,
  NoClaimablePrize = 13,
  InvalidProof = 14,
  InvalidMultisig = 15,
}

export interface ContractErrorDetail {
  code: EscrowContractErrorCode;
  name: string;
  title: string;
  description: string;
  userAction: string;
  isRetryable: boolean;
}

export const ESCROW_ERROR_CATALOG: Record<EscrowContractErrorCode, ContractErrorDetail> = {
  [EscrowContractErrorCode.AlreadyInitialized]: {
    code: EscrowContractErrorCode.AlreadyInitialized,
    name: "AlreadyInitialized",
    title: "Contract Already Initialized",
    description: "The escrow smart contract has already been initialized and cannot be re-initialized.",
    userAction: "No action needed. The contract is already in active operation.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.NotInitialized]: {
    code: EscrowContractErrorCode.NotInitialized,
    name: "NotInitialized",
    title: "Contract Not Initialized",
    description: "The escrow contract has not yet been initialized by the administrator.",
    userAction: "Contact the platform administrator to initialize the escrow contract.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.LeagueAlreadyExists]: {
    code: EscrowContractErrorCode.LeagueAlreadyExists,
    name: "LeagueAlreadyExists",
    title: "League Partition Already Exists",
    description: "A league partition with this ID already exists on-chain.",
    userAction: "Use a unique league identifier or join the existing league partition.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.LeagueNotFound]: {
    code: EscrowContractErrorCode.LeagueNotFound,
    name: "LeagueNotFound",
    title: "League Partition Not Found",
    description: "The requested league partition does not exist in on-chain escrow storage.",
    userAction: "Ensure the league has been created and registered on-chain before interacting.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.LeagueNotAcceptingDeposits]: {
    code: EscrowContractErrorCode.LeagueNotAcceptingDeposits,
    name: "LeagueNotAcceptingDeposits",
    title: "League Not Accepting Deposits",
    description: "This league is not in Upcoming status and cannot accept new participant entry fees.",
    userAction: "Deposits close once the gameweek deadline passes or league starts.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.AlreadyDeposited]: {
    code: EscrowContractErrorCode.AlreadyDeposited,
    name: "AlreadyDeposited",
    title: "Deposit Already Recorded",
    description: "This wallet has already deposited the entry fee into this league partition.",
    userAction: "Your entry fee is already confirmed in escrow. View your team on the pitch.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.AlreadySettled]: {
    code: EscrowContractErrorCode.AlreadySettled,
    name: "AlreadySettled",
    title: "League Already Settled",
    description: "This competition has already been settled and prizes have been allocated.",
    userAction: "Check the final leaderboard and prize claims for payout details.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.InvalidAmount]: {
    code: EscrowContractErrorCode.InvalidAmount,
    name: "InvalidAmount",
    title: "Invalid Amount Specified",
    description: "The fee, deposit, or payout amount was invalid, zero, or negative.",
    userAction: "Verify that all amounts are strictly positive and match league rules.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.PayoutExceedsDeposits]: {
    code: EscrowContractErrorCode.PayoutExceedsDeposits,
    name: "PayoutExceedsDeposits",
    title: "Payouts Exceed Escrow Balance",
    description: "The sum of winner payouts and treasury fees exceeds total deposited funds in the partition.",
    userAction: "Re-calculate winner distribution to ensure sum <= totalDeposited.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.NotAuthorized]: {
    code: EscrowContractErrorCode.NotAuthorized,
    name: "NotAuthorized",
    title: "Unauthorized Action",
    description: "The caller does not have the required administrative authority for this action.",
    userAction: "Only the designated escrow administrator can perform settlement or refund operations.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.FeeExceedsMaxCap]: {
    code: EscrowContractErrorCode.FeeExceedsMaxCap,
    name: "FeeExceedsMaxCap",
    title: "Platform Fee Exceeds Cap",
    description: "The requested platform treasury fee exceeds the maximum allowed 5% limit.",
    userAction: "Ensure platform fee is <= 5% of total deposited entry fees.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.InvalidPrizeDistribution]: {
    code: EscrowContractErrorCode.InvalidPrizeDistribution,
    name: "InvalidPrizeDistribution",
    title: "Invalid Prize Distribution",
    description: "The prize distribution percentages do not sum to 100% of the prize pool.",
    userAction: "Review prize distribution structure (e.g. 60/30/10) to ensure exact allocation.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.NoClaimablePrize]: {
    code: EscrowContractErrorCode.NoClaimablePrize,
    name: "NoClaimablePrize",
    title: "No Claimable Prize Found",
    description: "There is no claimable prize recorded for this participant address in the league.",
    userAction: "Verify your final standing and wallet address.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.InvalidProof]: {
    code: EscrowContractErrorCode.InvalidProof,
    name: "InvalidProof",
    title: "Invalid Settlement Proof",
    description: "The cryptographic settlement proof hash does not match calculation verification.",
    userAction: "Re-generate settlement commitment proof from authoritative gameweek scoring data.",
    isRetryable: false,
  },
  [EscrowContractErrorCode.InvalidMultisig]: {
    code: EscrowContractErrorCode.InvalidMultisig,
    name: "InvalidMultisig",
    title: "Multisig Threshold Not Met",
    description: "The provided admin signatures do not meet the required multisig threshold.",
    userAction: "Collect required number of valid administrator co-signatures.",
    isRetryable: false,
  },
};

export interface ParsedSorobanError {
  isContractError: boolean;
  errorCode?: EscrowContractErrorCode;
  errorDetail?: ContractErrorDetail;
  humanMessage: string;
  isRetryable: boolean;
  rawError: string;
}

/**
 * Parses raw error strings, simulation errors, or transaction result XDR
 * into structured Soroban diagnostic details.
 */
export function parseSorobanError(rawError: string | Error | unknown): ParsedSorobanError {
  const errorStr = rawError instanceof Error ? rawError.message : String(rawError || "Unknown error");

  // 1. Extract numeric contract error code: "Error(Contract, #6)" or "Error(Contract, 6)"
  const contractMatch =
    errorStr.match(/Error\(Contract,\s*#?(\d+)\)/i) ||
    errorStr.match(/contract\s+error\s*#?(\d+)/i) ||
    errorStr.match(/contractcode[:\s]+(\d+)/i);

  if (contractMatch) {
    const codeNum = parseInt(contractMatch[1], 10);
    const detail = ESCROW_ERROR_CATALOG[codeNum as EscrowContractErrorCode];
    if (detail) {
      return {
        isContractError: true,
        errorCode: detail.code,
        errorDetail: detail,
        humanMessage: `${detail.title}: ${detail.description}`,
        isRetryable: false,
        rawError: errorStr,
      };
    }

    return {
      isContractError: true,
      errorCode: codeNum,
      humanMessage: `Smart contract error #${codeNum}.`,
      isRetryable: false,
      rawError: errorStr,
    };
  }

  // 2. Insufficient token balance / allowance / trustline
  if (
    errorStr.toLowerCase().includes("balance") ||
    errorStr.toLowerCase().includes("trustline") ||
    errorStr.includes("op_no_trust") ||
    errorStr.includes("op_underfunded")
  ) {
    return {
      isContractError: false,
      humanMessage: "Insufficient balance or missing USDC trustline on your Stellar account.",
      isRetryable: false,
      rawError: errorStr,
    };
  }

  // 3. Transient sequence or RPC sync errors (Retryable!)
  if (
    errorStr.includes("txBAD_SEQ") ||
    errorStr.includes("tx_bad_seq") ||
    errorStr.includes("bad sequence")
  ) {
    return {
      isContractError: false,
      humanMessage: "Account sequence number out of sync. Automatic retry is supported.",
      isRetryable: true,
      rawError: errorStr,
    };
  }

  if (
    errorStr.toLowerCase().includes("timeout") ||
    errorStr.toLowerCase().includes("econnreset") ||
    errorStr.toLowerCase().includes("etimedout") ||
    errorStr.toLowerCase().includes("rate limit") ||
    errorStr.includes("504") ||
    errorStr.includes("503") ||
    errorStr.includes("429")
  ) {
    return {
      isContractError: false,
      humanMessage: "Stellar RPC node temporary network timeout or rate limit. Request will be retried.",
      isRetryable: true,
      rawError: errorStr,
    };
  }

  // 4. Footprint / storage restoration required
  if (errorStr.includes("restoreFootprint") || errorStr.includes("archived")) {
    return {
      isContractError: false,
      humanMessage: "Contract storage entry has been archived and requires footprint restoration.",
      isRetryable: false,
      rawError: errorStr,
    };
  }

  return {
    isContractError: false,
    humanMessage: errorStr,
    isRetryable: false,
    rawError: errorStr,
  };
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  onRetry?: (attempt: number, error: ParsedSorobanError) => void;
}

/**
 * Executes a Soroban operation with automatic exponential backoff retry for transient failures.
 */
export async function executeWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 8000;
  const backoffFactor = options?.backoffFactor ?? 2;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await operation(attempt);
    } catch (err: unknown) {
      const parsed = parseSorobanError(err);
      if (!parsed.isRetryable || attempt > maxRetries) {
        throw err;
      }

      options?.onRetry?.(attempt, parsed);

      const delay = Math.min(
        initialDelayMs * Math.pow(backoffFactor, attempt - 1),
        maxDelayMs
      );
      // Add slight jitter
      const jitter = Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
}

/**
 * State Recovery / Consistency Guard
 *
 * Runs an action that modifies state. If the subsequent Soroban invocation fails,
 * it runs a registered compensation/rollback handler to ensure the application state
 * remains completely consistent.
 */
export async function executeWithRollback<TResult, TRollbackState>(params: {
  name: string;
  prepareState: () => Promise<TRollbackState>;
  executeContract: (state: TRollbackState) => Promise<TResult>;
  rollbackState: (state: TRollbackState, error: ParsedSorobanError) => Promise<void>;
  isInvocationSuccessful?: (result: TResult) => boolean;
}): Promise<TResult> {
  const { name, prepareState, executeContract, rollbackState, isInvocationSuccessful } = params;

  const state = await prepareState();

  try {
    const result = await executeContract(state);

    // If result indicates logical contract failure (e.g. { success: false, error: ... })
    const isSuccess = isInvocationSuccessful ? isInvocationSuccessful(result) : true;
    if (!isSuccess) {
      const errorMsg = (result as any)?.error || "Contract invocation returned failure.";
      const parsed = parseSorobanError(errorMsg);
      console.warn(`[SorobanRollback] ${name} invocation failed on-chain. Triggering state rollback...`, {
        error: parsed.humanMessage,
      });
      await rollbackState(state, parsed);
    }

    return result;
  } catch (error: unknown) {
    const parsed = parseSorobanError(error);
    console.error(`[SorobanRollback] Exception in ${name}. Rolling back application state...`, {
      error: parsed.humanMessage,
    });
    try {
      await rollbackState(state, parsed);
    } catch (rollbackErr) {
      console.error(`[SorobanRollback] CRITICAL: Rollback handler failed for ${name}:`, rollbackErr);
    }
    throw error;
  }
}
