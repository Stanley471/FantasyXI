import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthContext } from "../context/AuthContext";
import { PrivacySettings } from "../components/profile/PrivacySettings";
import type { User } from "../types";

function fakeAuth(user: User | null) {
  return {
    user,
    token: "token",
    isLoading: false,
    isAuthenticated: Boolean(user),
    login: () => {},
    loginWithPasskey: async () => {},
    logout: () => {},
    setAuthToken: async () => {},
    refreshUser: async () => {},
  };
}

function manager(overrides: Partial<User> = {}): User {
  return {
    id: "user-alice",
    email: "alice@example.com",
    username: "alice",
    name: "Alice Example",
    role: "USER",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(user: User | null) {
  return renderToStaticMarkup(
    <AuthContext.Provider value={fakeAuth(user)}>
      <PrivacySettings />
    </AuthContext.Provider>
  );
}

describe("PrivacySettings toggle (issue #511)", () => {
  it("renders the switch off and no alias when anonymous mode is off", () => {
    const markup = render(manager({ isAnonymous: false }));
    assert.match(markup, /Anonymous mode/);
    assert.match(markup, /aria-checked="false"/);
    assert.doesNotMatch(markup, /You appear as/);
  });

  it("renders the switch on with the manager alias when anonymous mode is on", () => {
    const markup = render(manager({ isAnonymous: true, anonymousAlias: "Manager #3948" }));
    assert.match(markup, /aria-checked="true"/);
    assert.match(markup, /You appear as Manager #3948 in public standings\./);
  });

  it("renders the switch on without an alias line when no alias is provided", () => {
    const markup = render(manager({ isAnonymous: true }));
    assert.match(markup, /aria-checked="true"/);
    assert.doesNotMatch(markup, /You appear as/);
  });
});
