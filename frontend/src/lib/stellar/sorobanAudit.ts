import {
  Account,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export interface OnChainLeagueState {
  totalDeposited: number;
  participantCount: number;
  status: string;
}

const DEFAULT_SOROBAN_RPC =
  process.env.NEXT_PUBLIC_STELLAR_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const DEFAULT_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;

function toContractLeagueId(leagueId: number | string): bigint {
  const uuidHex = String(leagueId).replace(/-/g, "").slice(0, 16);
  if (typeof leagueId === "string" && /^[0-9a-fA-F]{8}-/.test(leagueId)) {
    return BigInt(`0x${uuidHex}`);
  }

  const numericLeagueId = typeof leagueId === "string" ? Number(leagueId) : leagueId;
  if (!Number.isSafeInteger(numericLeagueId) || numericLeagueId < 0) {
    throw new Error(`Invalid league ID for escrow: ${leagueId}`);
  }
  return BigInt(numericLeagueId);
}

function statusLabel(status: unknown): string {
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    const key = Object.keys(status)[0];
    if (key) return key;
  }
  return "Unknown";
}

export async function getOnChainLeague(
  leagueId: number | string,
  options: { contractId: string; rpcUrl?: string; networkPassphrase?: string }
): Promise<OnChainLeagueState> {
  const server = new rpc.Server(options.rpcUrl || DEFAULT_SOROBAN_RPC, {
    allowHttp: false,
  });
  const sourceAccount = new Account(Keypair.random().publicKey(), "0");
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: options.networkPassphrase || DEFAULT_NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(options.contractId).call(
        "get_league",
        nativeToScVal(toContractLeagueId(leagueId), { type: "u64" })
      )
    )
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (!("result" in simulation) || !simulation.result?.retval) {
    throw new Error("Soroban returned no league state for this league.");
  }

  const rawState = scValToNative(simulation.result.retval) as {
    total_deposited?: bigint | number;
    participant_count?: bigint | number;
    status?: unknown;
  } | null;
  if (!rawState) throw new Error("League was not found in Soroban escrow.");

  return {
    totalDeposited: Number(rawState.total_deposited || 0) / 10_000_000,
    participantCount: Number(rawState.participant_count || 0),
    status: statusLabel(rawState.status),
  };
}
