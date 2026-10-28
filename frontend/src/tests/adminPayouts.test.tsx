import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdminPayoutsPage from "../app/admin/payouts/page.js";
import { AuthContext } from "../context/AuthContext.js";
import { ToastContext } from "../context/ToastContext.js";
import { FailedPayoutStatus, FailedPayoutRecord } from "../types/index.js";

function renderWithProviders(
  ui: React.ReactElement,
  userRole: "USER" | "ADMIN" | "MODERATOR" | null,
  isAuthenticated: boolean
) {
  const mockUser = userRole
    ? {
        id: "usr-1",
        username: "testuser",
        email: "test@example.com",
        role: userRole,
        createdAt: "2026-01-01T00:00:00Z",
      }
    : null;

  const authValue = {
    user: mockUser,
    token: isAuthenticated ? "mock-jwt" : null,
    isAuthenticated,
    isLoading: false,
    login: () => {},
    loginWithPasskey: async () => {},
    logout: () => {},
    setAuthToken: async () => {},
    refreshUser: async () => {},
  };

  const toastCallable = Object.assign(
    (msg: string) => "toast-id",
    {
      success: () => "toast-id",
      error: () => "toast-id",
      info: () => "toast-id",
      warning: () => "toast-id",
    }
  );

  const toastValue = {
    toasts: [],
    toast: toastCallable,
    success: () => "toast-id",
    error: () => "toast-id",
    info: () => "toast-id",
    warning: () => "toast-id",
    dismiss: () => {},
    dismissAll: () => {},
  };

  return renderToStaticMarkup(
    <AuthContext.Provider value={authValue}>
      <ToastContext.Provider value={toastValue}>
        {ui}
      </ToastContext.Provider>
    </AuthContext.Provider>
  );
}

describe("Admin Payouts Dead-Letter Page", () => {
  it("renders 403 Forbidden when unauthenticated", () => {
    const html = renderWithProviders(<AdminPayoutsPage />, null, false);

    assert.ok(html.includes("403 - Forbidden"));
    assert.ok(html.includes("Authentication is required to access the administrator payout portal"));
    assert.ok(html.includes("Sign In with Staff Account"));
  });

  it("renders 403 Access Denied when user does not have staff privileges", () => {
    const html = renderWithProviders(<AdminPayoutsPage />, "USER", true);

    assert.ok(html.includes("403 - Access Denied"));
    assert.ok(html.includes("You do not have staff permissions to inspect or manage dead-letter payouts"));
  });

  it("renders the dashboard for ADMIN users", () => {
    const html = renderWithProviders(<AdminPayoutsPage />, "ADMIN", true);

    assert.ok(html.includes("Dead-Letter Payouts"));
    assert.ok(html.includes("Admin Portal"));
    assert.ok(html.includes("Failed Payouts Dead-Letter Queue"));
    assert.ok(html.includes("Filter by League ID..."));
  });

  it("renders the dashboard for MODERATOR staff users", () => {
    const html = renderWithProviders(<AdminPayoutsPage />, "MODERATOR", true);

    assert.ok(html.includes("Dead-Letter Payouts"));
    assert.ok(html.includes("Admin Portal"));
  });

  it("has accessible table structure and headers", () => {
    const html = renderWithProviders(<AdminPayoutsPage />, "ADMIN", true);

    assert.ok(html.includes("<table"));
    assert.ok(html.includes("<caption"));
    assert.ok(html.includes('scope="col"'));
    assert.ok(html.includes("ID / Type"));
    assert.ok(html.includes("League ID"));
    assert.ok(html.includes("Recipient(s)"));
    assert.ok(html.includes("Amount"));
    assert.ok(html.includes("Attempts"));
    assert.ok(html.includes("Status"));
    assert.ok(html.includes("Error Trace"));
  });
});
