/**
 * React Hook Interface for High-Performance Background Squad Solving
 *
 * Coordinates WebWorker message passing and provides automatic synchronous
 * fallback for SSR, test environments, or unsupported browsers.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  FormationConstraintSolver,
  SolverPlayer,
  SquadConstraintValidationResult,
  TransferEvaluationResult,
} from "@/lib/solver/formationConstraintSolver";

export function useSquadSolver() {
  const [isSolving, setIsSolving] = useState<boolean>(false);
  const [lastSolveTimeMs, setLastSolveTimeMs] = useState<number>(0);
  const workerRef = useRef<Worker | null>(null);
  const pendingCallbacks = useRef<Map<string, { resolve: (data: any) => void; reject: (err: any) => void }>>(
    new Map()
  );

  const isWorkerSupported =
    typeof window !== "undefined" && typeof Worker !== "undefined";

  useEffect(() => {
    if (!isWorkerSupported) return;

    try {
      // Initialize solver WebWorker
      const worker = new Worker(
        new URL("../workers/formationSolver.worker.ts", import.meta.url)
      );

      worker.onmessage = (event: MessageEvent) => {
        const { id, success, data, error, durationMs } = event.data;
        setLastSolveTimeMs(durationMs || 0);
        setIsSolving(false);

        const cb = pendingCallbacks.current.get(id);
        if (cb) {
          pendingCallbacks.current.delete(id);
          if (success) {
            cb.resolve(data);
          } else {
            cb.reject(new Error(error || "Worker solver failure"));
          }
        }
      };

      worker.onerror = (err) => {
        setIsSolving(false);
        console.warn("[squad-solver-worker] Worker error, falling back:", err);
      };

      workerRef.current = worker;
    } catch {
      // Fallback
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      pendingCallbacks.current.clear();
    };
  }, [isWorkerSupported]);

  const dispatchOrFallback = useCallback(
    async <T>(type: string, payload: any, fallbackFn: () => T): Promise<T> => {
      setIsSolving(true);
      const start = performance.now();

      if (!workerRef.current) {
        // Synchronous graceful fallback
        try {
          const result = fallbackFn();
          setLastSolveTimeMs(performance.now() - start);
          setIsSolving(false);
          return result;
        } catch (err) {
          setIsSolving(false);
          throw err;
        }
      }

      return new Promise<T>((resolve, reject) => {
        const id = Math.random().toString(36).substring(2, 9);
        pendingCallbacks.current.set(id, { resolve, reject });

        workerRef.current!.postMessage({
          id,
          type,
          payload,
        });

        // 3-second timeout guard
        setTimeout(() => {
          if (pendingCallbacks.current.has(id)) {
            pendingCallbacks.current.delete(id);
            setIsSolving(false);
            // Fall back to synchronous evaluation on worker timeout
            try {
              resolve(fallbackFn());
            } catch (err) {
              reject(err);
            }
          }
        }, 3000);
      });
    },
    []
  );

  const validateSquad = useCallback(
    (players: SolverPlayer[], maxBudgetTenths?: number): Promise<SquadConstraintValidationResult> => {
      return dispatchOrFallback(
        "VALIDATE_SQUAD",
        { players, maxBudgetTenths },
        () => FormationConstraintSolver.validateSquad(players, maxBudgetTenths)
      );
    },
    [dispatchOrFallback]
  );

  const evaluateTransfer = useCallback(
    (
      currentSquad: SolverPlayer[],
      playerOutId: number,
      playerIn: SolverPlayer,
      maxBudgetTenths?: number
    ): Promise<TransferEvaluationResult> => {
      return dispatchOrFallback(
        "EVALUATE_TRANSFER",
        { currentSquad, playerOutId, playerIn, maxBudgetTenths },
        () =>
          FormationConstraintSolver.evaluateTransfer(
            currentSquad,
            playerOutId,
            playerIn,
            maxBudgetTenths
          )
      );
    },
    [dispatchOrFallback]
  );

  const getValidFormations = useCallback(
    (players: SolverPlayer[]): Promise<string[]> => {
      return dispatchOrFallback(
        "GET_VALID_FORMATIONS",
        { players },
        () => FormationConstraintSolver.findPermissibleFormations(players)
      );
    },
    [dispatchOrFallback]
  );

  const filterFeasibleTransfers = useCallback(
    (
      currentSquad: SolverPlayer[],
      playerOutId: number,
      candidatePool: SolverPlayer[],
      maxBudgetTenths?: number
    ): Promise<SolverPlayer[]> => {
      return dispatchOrFallback(
        "FILTER_FEASIBLE_TRANSFERS",
        { currentSquad, playerOutId, candidatePool, maxBudgetTenths },
        () =>
          FormationConstraintSolver.filterFeasibleTransfers(
            currentSquad,
            playerOutId,
            candidatePool,
            maxBudgetTenths
          )
      );
    },
    [dispatchOrFallback]
  );

  return {
    isSolving,
    lastSolveTimeMs,
    isWorkerSupported,
    validateSquad,
    evaluateTransfer,
    getValidFormations,
    filterFeasibleTransfers,
  };
}
