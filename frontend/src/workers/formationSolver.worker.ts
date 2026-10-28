/**
 * Dedicated Background WebWorker for Formation Solving & Squad Constraint Validation
 *
 * Runs off the main UI thread to ensure zero dropped frames (60fps) during
 * rapid drag-and-drop squad mutations and player transfer evaluations.
 */

import {
  FormationConstraintSolver,
  SolverPlayer,
} from "../lib/solver/formationConstraintSolver";

export interface SolverWorkerMessageRequest {
  id: string;
  type:
    | "VALIDATE_SQUAD"
    | "EVALUATE_TRANSFER"
    | "GET_VALID_FORMATIONS"
    | "FILTER_FEASIBLE_TRANSFERS";
  payload: any;
}

export interface SolverWorkerMessageResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  durationMs: number;
}

self.onmessage = (event: MessageEvent<SolverWorkerMessageRequest>) => {
  const { id, type, payload } = event.data;
  const start = performance.now();

  try {
    let resultData: any;

    switch (type) {
      case "VALIDATE_SQUAD": {
        const { players, maxBudgetTenths } = payload;
        resultData = FormationConstraintSolver.validateSquad(
          players as SolverPlayer[],
          maxBudgetTenths
        );
        break;
      }
      case "EVALUATE_TRANSFER": {
        const { currentSquad, playerOutId, playerIn, maxBudgetTenths } = payload;
        resultData = FormationConstraintSolver.evaluateTransfer(
          currentSquad,
          playerOutId,
          playerIn,
          maxBudgetTenths
        );
        break;
      }
      case "GET_VALID_FORMATIONS": {
        const { players } = payload;
        resultData = FormationConstraintSolver.findPermissibleFormations(players);
        break;
      }
      case "FILTER_FEASIBLE_TRANSFERS": {
        const { currentSquad, playerOutId, candidatePool, maxBudgetTenths } = payload;
        resultData = FormationConstraintSolver.filterFeasibleTransfers(
          currentSquad,
          playerOutId,
          candidatePool,
          maxBudgetTenths
        );
        break;
      }
      default:
        throw new Error(`Unknown solver action: ${type}`);
    }

    const durationMs = performance.now() - start;
    self.postMessage({
      id,
      success: true,
      data: resultData,
      durationMs,
    } as SolverWorkerMessageResponse);
  } catch (err) {
    const durationMs = performance.now() - start;
    self.postMessage({
      id,
      success: false,
      error: (err as Error).message,
      durationMs,
    } as SolverWorkerMessageResponse);
  }
};
