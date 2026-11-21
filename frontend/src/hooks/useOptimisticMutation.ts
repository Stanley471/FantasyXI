/**
 * useOptimisticMutation.ts - Optimistic UI updates with automatic rollback
 *
 * Provides a hook for applying mutations optimistically to local state while
 * queuing the server request. On success, the server state is authoritative.
 * On failure, the mutation is rolled back to the previous state.
 *
 * Implements Issue #520: optimistic updates for squad transfer actions
 * (player swap, captain selection, vice-captain selection).
 */

import { useCallback, useRef } from "react";
import { ApiError } from "@/lib/api";
import { isOfflineError } from "@/lib/offlineStore";
import { emitToast } from "@/context/ToastContext";

export interface OptimisticMutationOptions<T, R = void> {
  /** Async function that mutates the server. Should throw on failure. */
  mutationFn: () => Promise<R>;
  /** Called immediately to apply the mutation optimistically to local state. Returns previous state for rollback. */
  onOptimisticApply: () => T;
  /** Called if the server rejects the mutation; receives the previous state to restore. */
  onRollback: (previousState: T) => void;
  /** Optional success callback after server confirms the mutation. */
  onSuccess?: (response: R) => void;
  /** Optional error callback. Return true to prevent default error toast. */
  onError?: (error: unknown) => boolean;
  /** Toast message to show on error (if not suppressed by onError). */
  errorMessage?: string;
}

export interface OptimisticMutationState {
  isLoading: boolean;
  error: Error | null;
}

/**
 * Hook for optimistic mutations with automatic rollback.
 * 
 * Usage:
 * ```
 * const { mutate, isLoading } = useOptimisticMutation({
 *   onOptimisticApply: () => {
 *     const prev = state.players;
 *     setState(swappedPlayers);
 *     return prev;
 *   },
 *   mutationFn: () => api.put(`/api/v1/squads/${id}`, payload),
 *   onRollback: (prev) => setState(prev),
 *   errorMessage: "Failed to swap players",
 * });
 * 
 * await mutate();
 * ```
 */
export function useOptimisticMutation<T, R = void>(
  options: OptimisticMutationOptions<T, R>
): { mutate: () => Promise<void>; isLoading: boolean; error: Error | null } {
  const stateRef = useRef<OptimisticMutationState>({
    isLoading: false,
    error: null,
  });

  const mutate = useCallback(async () => {
    // Prevent concurrent mutations
    if (stateRef.current.isLoading) {
      return;
    }

    let previousState: T | null = null;
    stateRef.current.isLoading = true;
    stateRef.current.error = null;

    try {
      // Apply the mutation optimistically to local state
      previousState = options.onOptimisticApply();

      // Send the mutation to the server
      const response = await options.mutationFn();

      // Call success callback if provided
      options.onSuccess?.(response);

      stateRef.current.error = null;
    } catch (err: unknown) {
      // Rollback the optimistic update if the server rejects it
      if (previousState !== null) {
        options.onRollback(previousState);
      }

      const error = err instanceof Error ? err : new Error("Unknown error");
      stateRef.current.error = error;

      // Allow caller to suppress default error handling
      const suppressed = options.onError?.(err) ?? false;

      if (!suppressed) {
        const errorMsg = options.errorMessage || getDefaultErrorMessage(err);
        emitToast.error(errorMsg);
      }
    } finally {
      stateRef.current.isLoading = false;
    }
  }, [options]);

  return {
    mutate,
    isLoading: stateRef.current.isLoading,
    error: stateRef.current.error,
  };
}

function getDefaultErrorMessage(error: unknown): string {
  if (isOfflineError(error)) {
    return "You are offline. Your changes will be synced when you reconnect.";
  }
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return "Conflict: your squad was modified elsewhere. Please refresh.";
    }
    if (error.status === 403) {
      return "Cannot modify squad: lineup locked or deadline passed.";
    }
    return error.message || "Failed to save changes.";
  }
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}
