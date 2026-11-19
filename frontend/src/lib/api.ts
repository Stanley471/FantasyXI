/**
 * Centralised API client for calling the Express backend.
 *
 * Every frontend component that needs backend data goes through this module.
 *
 * Laravel equivalent: This is like creating a service class that wraps
 * Http::get() / Http::post() calls, so you never write raw fetch() in
 * your Blade templates or controllers.
 *
 * Usage:
 *   import { api } from "@/lib/api";
 *   const players = await api.get<Player[]>("/api/players");
 */

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

/**
 * Custom error class for API responses that aren't OK (4xx/5xx).
 */
export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

/**
 * Core fetch wrapper. Handles:
 * - Base URL prefixing
 * - JSON content-type headers
 * - Auth token injection (from localStorage)
 * - Error response parsing
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();

  // Get auth token if it exists
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    void import("@/lib/telemetry").then(({ trackApiLatency }) =>
      trackApiLatency(options.method ?? "GET", endpoint, endedAt - startedAt, 0)
    );
    throw error;
  }
  const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  void import("@/lib/telemetry").then(({ trackApiLatency }) =>
    trackApiLatency(options.method ?? "GET", endpoint, endedAt - startedAt, response.status)
  );

  // Handle no-content responses (204)
  if (response.status === 204) {
    return undefined as T;
  }

  const data = await response.json();

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.message || "An error occurred",
      data
    );
  }

  return data as T;
}

/**
 * API client with convenience methods for each HTTP verb.
 *
 * Examples:
 *   api.get("/api/players")
 *   api.post("/api/auth/login", { email, password })
 *   api.put("/api/squads/123", { name: "My Squad" })
 *   api.del("/api/squads/123")
 */
export const api = {
  get<T>(endpoint: string): Promise<T> {
    return request<T>(endpoint, { method: "GET" });
  },

  post<T>(endpoint: string, body?: unknown): Promise<T> {
    return request<T>(endpoint, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  put<T>(endpoint: string, body?: unknown): Promise<T> {
    return request<T>(endpoint, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  patch<T>(endpoint: string, body?: unknown): Promise<T> {
    return request<T>(endpoint, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  del<T>(endpoint: string): Promise<T> {
    return request<T>(endpoint, { method: "DELETE" });
  },
};
