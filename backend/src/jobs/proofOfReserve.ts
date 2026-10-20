import { proofOfReserveService } from "../services/financial/proofOfReserveService.js";

/**
 * Proof-of-Reserve Job (issue #309).
 *
 * Rebuilds the deposit Merkle roots and checks them against the escrow
 * contract and its token reserve. Discrepancies are audited and sent to
 * administrators by the service itself; the job only logs a one-line summary.
 */
export async function runProofOfReserveJob(): Promise<void> {
  const snapshot = await proofOfReserveService.generateSnapshot("scheduled");
  const line =
    `[jobs] Proof of reserve ${snapshot.runId}: ${snapshot.depositCount} deposits, ` +
    `root ${snapshot.onChainRoot.slice(0, 16)}…, reserve ${snapshot.reserveStroops}/${snapshot.liabilitiesStroops} stroops, ` +
    `${snapshot.discrepancies.length} discrepanc${snapshot.discrepancies.length === 1 ? "y" : "ies"}`;
  if (snapshot.status === "VERIFIED") console.log(line);
  else console.warn(line);
}
