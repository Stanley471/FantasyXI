"use client";

import {
  broadcastSessionRevocation,
  useCrossTabSessionSync,
} from "@/hooks/useCrossTabSessionSync";

import React, { createContext, useContext, useState, useEffect } from "react";
import { User, AuthResponse, ApiSuccessResponse } from "@/types";
import { api, API_BASE_URL } from "@/lib/api";
import { getRealtimeBus } from "@/lib/realtime/realtimeBus";
import { authenticateWithPasskey, type PublicKeyCredentialRequestOptionsJSON } from "@/lib/passkeys";
import { authenticateWithStellar } from "@/lib/stellarAuth";
import type { WalletTransactionSigner } from "@/lib/stellar/sorobanDeposit";
import {
  clearOfflineData,
  isOfflineError,
  loadOfflineUser,
  saveOfflineUser,
} from "@/lib/offlineStore";

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (token: string, user: User) => void;
  /** Passkey sign-in; pass the options of a WEBAUTHN login challenge to complete a step-up (issue #273) */
  loginWithPasskey: (stepUpOptions?: PublicKeyCredentialRequestOptionsJSON) => Promise<void>;
  /** SEP-0010 sign-in with a connected Stellar wallet (issue #562) */
  loginWithStellar: (address: string, signTransaction: WalletTransactionSigner) => Promise<void>;
  logout: () => void;
  setAuthToken: (token: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshUserWithToken = async (currentToken: string) => {
    try {
      const res = await api.get<ApiSuccessResponse<User>>("/api/v1/auth/me");
      if (res?.success && res.data) {
        setUser(res.data);
        saveOfflineUser(res.data);
      } else {
        // Token invalid
        localStorage.removeItem("token");
        setToken(null);
        setUser(null);
      }
    } catch (error) {
      // Offline: keep the session and use the profile saved on the last visit,
      // so cached pages (e.g. the squad) stay available without a connection
      const cachedUser = isOfflineError(error) ? loadOfflineUser() : null;
      if (cachedUser) {
        setUser(cachedUser);
        return;
      }
      // Expired / revoked token
      localStorage.removeItem("token");
      setToken(null);
      setUser(null);
    }
  };

  useEffect(() => {
    const savedToken = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (savedToken) {
      setToken(savedToken);
      refreshUserWithToken(savedToken).finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = (newToken: string, newUser: User) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("token", newToken);
      saveOfflineUser(newUser);
    }
    setToken(newToken);
    setUser(newUser);
  };

  const loginWithPasskey = async (stepUpOptions?: PublicKeyCredentialRequestOptionsJSON) => {
    const session = await authenticateWithPasskey(stepUpOptions);
    login(session.token, session.user);
  };

  const loginWithStellar = async (address: string, signTransaction: WalletTransactionSigner) => {
    const session = await authenticateWithStellar(address, signTransaction);
    login(session.token, session.user);
  };

  const logout = () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("token");
      clearOfflineData();
      broadcastSessionRevocation({
        type: "LOGOUT",
        timestamp: Date.now(),
      });
      // Fan the logout through the realtime bus as well (issue #459): the
      // SharedWorker closes every socket and tells every other tab to sign
      // out now. The session-sync broadcast above stays as the fallback.
      try {
        getRealtimeBus(API_BASE_URL, () => localStorage.getItem("token")).notifyLogout();
      } catch {
        // session-sync broadcast already covers the other tabs
      }
    }
    setToken(null);
    setUser(null);
  };

  // Realtime bus (SharedWorker) auth fan-out: a logout in any tab arrives
  // here via the worker and signs this tab out instantly, no reload.
  // The storage/BroadcastChannel listener above stays as the fallback.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const bus = getRealtimeBus(API_BASE_URL, () => localStorage.getItem("token"));
    bus.connect();
    const unsubscribe = bus.onAuthLogout(() => {
      if (typeof window !== "undefined") {
        localStorage.removeItem("token");
        clearOfflineData();
      }
      setToken(null);
      setUser(null);
    });
    return () => {
      unsubscribe();
      bus.disconnect();
    };
  }, []);

  // Cross-tab & multi-device remote invalidation listener
  useCrossTabSessionSync({
    token,
    onSessionRevoked: () => {
      if (typeof window !== "undefined") {
        localStorage.removeItem("token");
        clearOfflineData();
      }
      setToken(null);
      setUser(null);
    },
  });

  const setAuthToken = async (newToken: string) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("token", newToken);
    }
    setToken(newToken);
    await refreshUserWithToken(newToken);
  };

  const refreshUser = async () => {
    if (token) {
      await refreshUserWithToken(token);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        isAuthenticated: !!user && !!token,
        login,
        loginWithPasskey,
        loginWithStellar,
        logout,
        setAuthToken,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
