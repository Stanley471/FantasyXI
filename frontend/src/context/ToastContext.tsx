"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  ReactNode,
} from "react";
import { ToastType, ToastOptions, ToastItem } from "@/types";
import { ToastContainer } from "@/components/ui/ToastContainer";

export type { ToastType, ToastOptions, ToastItem } from "@/types";

export interface ToastFn {
  (message: string, type?: ToastType, options?: ToastOptions): string;
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;
  warning: (message: string, options?: ToastOptions) => string;
}

export interface ToastContextType {
  toasts: ToastItem[];
  toast: ToastFn;
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;
  warning: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const DEFAULT_DURATION = 4000;
const MAX_TOASTS = 5;
const TOAST_EVENT_NAME = "fantasyxi:toast";

interface ToastCustomEventDetail {
  message: string;
  type: ToastType;
  options?: ToastOptions;
}

/**
 * Standalone emitter for triggering toasts from non-React contexts
 * (e.g. Zustand stores, Axios interceptors, event handlers).
 */
export function emitToast(
  message: string,
  type: ToastType = "info",
  options?: ToastOptions
): void {
  if (typeof window !== "undefined") {
    const event = new CustomEvent<ToastCustomEventDetail>(TOAST_EVENT_NAME, {
      detail: { message, type, options },
    });
    window.dispatchEvent(event);
  }
}

emitToast.success = (message: string, options?: ToastOptions) =>
  emitToast(message, "success", options);
emitToast.error = (message: string, options?: ToastOptions) =>
  emitToast(message, "error", options);
emitToast.info = (message: string, options?: ToastOptions) =>
  emitToast(message, "info", options);
emitToast.warning = (message: string, options?: ToastOptions) =>
  emitToast(message, "warning", options);

export const ToastContext = createContext<ToastContextType | undefined>(undefined);

let toastIdCounter = 0;
function generateToastId(): string {
  toastIdCounter = (toastIdCounter + 1) % 1000000;
  return `toast-${Date.now()}-${toastIdCounter}`;
}

function createToastCallable(
  addToast: (message: string, type?: ToastType, options?: ToastOptions) => string,
  success: (message: string, options?: ToastOptions) => string,
  error: (message: string, options?: ToastOptions) => string,
  info: (message: string, options?: ToastOptions) => string,
  warning: (message: string, options?: ToastOptions) => string
): ToastFn {
  const callable = ((message: string, type: ToastType = "info", options?: ToastOptions) =>
    addToast(message, type, options)) as ToastFn;
  callable.success = success;
  callable.error = error;
  callable.info = info;
  callable.warning = warning;
  return callable;
}

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    setToasts([]);
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = "info", options?: ToastOptions): string => {
      const id = options?.id || generateToastId();
      const duration =
        typeof options?.duration === "number" ? options.duration : DEFAULT_DURATION;

      const newToast: ToastItem = {
        id,
        type,
        message,
        title: options?.title,
        duration,
        action: options?.action,
        createdAt: Date.now(),
      };

      setToasts((prev) => {
        // If a toast with this id already exists, replace it
        const exists = prev.some((t) => t.id === id);
        let updated: ToastItem[];
        if (exists) {
          updated = prev.map((t) => (t.id === id ? newToast : t));
        } else {
          updated = [...prev, newToast];
        }

        // Keep at most MAX_TOASTS
        if (updated.length > MAX_TOASTS) {
          return updated.slice(updated.length - MAX_TOASTS);
        }
        return updated;
      });

      return id;
    },
    []
  );

  const success = useCallback(
    (message: string, options?: ToastOptions) => addToast(message, "success", options),
    [addToast]
  );

  const error = useCallback(
    (message: string, options?: ToastOptions) => addToast(message, "error", options),
    [addToast]
  );

  const info = useCallback(
    (message: string, options?: ToastOptions) => addToast(message, "info", options),
    [addToast]
  );

  const warning = useCallback(
    (message: string, options?: ToastOptions) => addToast(message, "warning", options),
    [addToast]
  );

  // Listen for non-React events dispatched via emitToast
  useEffect(() => {
    const handleCustomToast = (e: Event) => {
      const customEvent = e as CustomEvent<ToastCustomEventDetail>;
      if (customEvent.detail) {
        const { message, type, options } = customEvent.detail;
        addToast(message, type, options);
      }
    };

    window.addEventListener(TOAST_EVENT_NAME, handleCustomToast);
    return () => {
      window.removeEventListener(TOAST_EVENT_NAME, handleCustomToast);
    };
  }, [addToast]);

  // Build the callable toast function with attached helper methods
  const toastFn: ToastFn = useMemo(
    () => createToastCallable(addToast, success, error, info, warning),
    [addToast, success, error, info, warning]
  );

  return (
    <ToastContext.Provider
      value={{
        toasts,
        toast: toastFn,
        success,
        error,
        info,
        warning,
        dismiss,
        dismissAll,
      }}
    >
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
};
