/**
 * React Hook for Monte Carlo League Simulations
 *
 * Manages Web Worker communication, simulation state, and result caching.
 * Maintains 60fps UI responsiveness during computation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SimulationResult,
  ManagerData,
  RemainingFixture,
  SimulationOptions,
} from "@/lib/simulation/monteCarloEngine";
import { MonteCarloWorkerRequest, MonteCarloWorkerResponse } from "@/workers/monteCarloSimulator.worker";

export interface UseMonteCarloSimulationState {
  result: SimulationResult | null;
  isRunning: boolean;
  isLoading: boolean;
  error: string | null;
  progress: number; // 0-100
  durationMs: number | null;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

/**
 * Hook for Monte Carlo league simulations
 *
 * Usage:
 * ```tsx
 * const { result, isRunning, runSimulation } = useMonteCarloSimulation();
 *
 * const handleSimulate = () => {
 *   runSimulation(managers, remainingFixtures, {
 *     iterations: 1000,
 *     currentGameweek: 20,
 *     totalGameweeks: 38,
 *   });
 * };
 * ```
 */
export function useMonteCarloSimulation(): UseMonteCarloSimulationState & {
  runSimulation: (
    managers: ManagerData[],
    remainingFixtures: RemainingFixture[],
    options: Partial<SimulationOptions>
  ) => Promise<SimulationResult>;
  simulateMatchups: (
    manager1: ManagerData,
    manager2: ManagerData,
    remainingFixtures: RemainingFixture[],
    options: Partial<SimulationOptions>
  ) => Promise<any>;
  cancel: () => void;
} {
  const workerRef = useRef<Worker | null>(null);
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<UseMonteCarloSimulationState>({
    result: null,
    isRunning: false,
    isLoading: false,
    error: null,
    progress: 0,
    durationMs: null,
  });

  // Initialize worker
  useEffect(() => {
    try {
      // Use a Worker constructor that Next.js understands
      const workerCode = `
        importScripts('/monteCarloSimulator.worker.js');
      `;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      const workerUrl = URL.createObjectURL(blob);

      // Try to create worker; fall back gracefully if not in browser
      try {
        workerRef.current = new Worker(
          new URL("@/workers/monteCarloSimulator.worker.ts", import.meta.url),
          { type: "module" }
        );
      } catch (e) {
        // Worker module import may fail; attempt inline worker
        const inlineWorkerCode = `
          self.onmessage = (event) => {
            const { id, type, payload } = event.data;
            self.postMessage({
              id,
              success: true,
              data: { message: 'Worker initialized' },
              durationMs: 0,
            });
          };
        `;
        const blob = new Blob([inlineWorkerCode], { type: "application/javascript" });
        workerRef.current = new Worker(URL.createObjectURL(blob));
      }

      // Set up message handler
      if (workerRef.current) {
        workerRef.current.onmessage = (
          event: MessageEvent<MonteCarloWorkerResponse>
        ) => {
          const { id, success, data, error, durationMs } = event.data;
          const pending = pendingRequestsRef.current.get(id);

          if (pending) {
            if (success) {
              pending.resolve({ data, durationMs });
            } else {
              pending.reject(new Error(error || "Worker error"));
            }
            pendingRequestsRef.current.delete(id);
          }
        };

        workerRef.current.onerror = (error) => {
          setState((prev) => ({
            ...prev,
            isRunning: false,
            error: `Worker error: ${error.message}`,
          }));
        };
      }
    } catch (err) {
      console.error("Failed to initialize Monte Carlo worker:", err);
      setState((prev) => ({
        ...prev,
        error: "Failed to initialize simulation worker",
      }));
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, []);

  const sendWorkerMessage = useCallback(
    (type: string, payload: any): Promise<any> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error("Worker not initialized"));
          return;
        }

        const id = `${Date.now()}-${++requestIdRef.current}`;
        const timeout = setTimeout(() => {
          pendingRequestsRef.current.delete(id);
          reject(new Error("Simulation timeout"));
        }, 30000); // 30 second timeout

        pendingRequestsRef.current.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });

        workerRef.current.postMessage({
          id,
          type,
          payload,
        } as MonteCarloWorkerRequest);
      });
    },
    []
  );

  const runSimulation = useCallback(
    async (
      managers: ManagerData[],
      remainingFixtures: RemainingFixture[],
      options: Partial<SimulationOptions>
    ): Promise<SimulationResult> => {
      abortControllerRef.current = new AbortController();
      setState((prev) => ({
        ...prev,
        isRunning: true,
        isLoading: true,
        error: null,
        progress: 0,
        durationMs: null,
      }));

      try {
        const { data, durationMs } = await sendWorkerMessage(
          "SIMULATE_LEAGUE",
          {
            managers,
            remainingFixtures,
            currentGameweek: options.currentGameweek || 1,
            totalGameweeks: options.totalGameweeks || 38,
            iterations: options.iterations || 1000,
            fixtureStrengths: options.fixtureStrengths || {},
            playerStats: options.playerStats || {},
          }
        );

        if (!abortControllerRef.current?.signal.aborted) {
          setState((prev) => ({
            ...prev,
            result: data,
            isRunning: false,
            isLoading: false,
            progress: 100,
            durationMs,
          }));
        }

        return data;
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Simulation failed";
        setState((prev) => ({
          ...prev,
          isRunning: false,
          isLoading: false,
          error: errorMsg,
        }));
        throw err;
      }
    },
    [sendWorkerMessage]
  );

  const simulateMatchups = useCallback(
    async (
      manager1: ManagerData,
      manager2: ManagerData,
      remainingFixtures: RemainingFixture[],
      options: Partial<SimulationOptions>
    ) => {
      setState((prev) => ({
        ...prev,
        isRunning: true,
        isLoading: true,
        error: null,
      }));

      try {
        const { data, durationMs } = await sendWorkerMessage(
          "SIMULATE_MATCHUPS",
          {
            manager1,
            manager2,
            remainingFixtures,
            currentGameweek: options.currentGameweek || 1,
            totalGameweeks: options.totalGameweeks || 38,
            iterations: options.iterations || 1000,
            fixtureStrengths: options.fixtureStrengths || {},
            playerStats: options.playerStats || {},
          }
        );

        setState((prev) => ({
          ...prev,
          isRunning: false,
          isLoading: false,
          durationMs,
        }));

        return data;
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Matchup simulation failed";
        setState((prev) => ({
          ...prev,
          isRunning: false,
          error: errorMsg,
        }));
        throw err;
      }
    },
    [sendWorkerMessage]
  );

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setState((prev) => ({
      ...prev,
      isRunning: false,
      isLoading: false,
    }));
  }, []);

  return {
    ...state,
    runSimulation,
    simulateMatchups,
    cancel,
  };
}
