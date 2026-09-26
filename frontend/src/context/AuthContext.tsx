"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { User, AuthResponse, ApiSuccessResponse } from "@/types";
import { api } from "@/lib/api";
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
  logout: () => void;
  setAuthToken: (token: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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

  const logout = () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("token");
      clearOfflineData();
    }
    setToken(null);
    setUser(null);
  };

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
