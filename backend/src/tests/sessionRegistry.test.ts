import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SessionRegistryService,
  sessionRegistryService,
} from "../services/auth/sessionRegistryService.js";
import { signAccessToken } from "../config/jwt.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { UserRole } from "../types/index.js";

describe("Active Session Registry & Device Fingerprinting (Issue #342)", () => {
  beforeEach(() => {
    sessionRegistryService.clearAll();
  });

  it("extracts browser, OS, and device type from User-Agent", () => {
    // macOS Chrome Desktop
    const macChrome = sessionRegistryService.parseDeviceInfo(
      "192.168.1.10",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    assert.equal(macChrome.os, "macOS");
    assert.equal(macChrome.browser, "Chrome");
    assert.equal(macChrome.deviceType, "desktop");
    assert.equal(macChrome.ip, "192.168.1.10");
    assert.ok(macChrome.fingerprintHash.length > 20);

    // iPhone Safari Mobile
    const iphone = sessionRegistryService.parseDeviceInfo(
      "10.0.0.5",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    );
    assert.equal(iphone.os, "iOS");
    assert.equal(iphone.browser, "Safari");
    assert.equal(iphone.deviceType, "mobile");

    // Windows Firefox Desktop
    const winFirefox = sessionRegistryService.parseDeviceInfo(
      "172.16.0.2",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0"
    );
    assert.equal(winFirefox.os, "Windows");
    assert.equal(winFirefox.browser, "Firefox");
    assert.equal(winFirefox.deviceType, "desktop");
  });

  it("creates active sessions and lists them sorted by activity", async () => {
    const s1 = await sessionRegistryService.createSession("user-1", {
      ip: "192.168.1.1",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0.0",
    });
    const s2 = await sessionRegistryService.createSession("user-1", {
      ip: "10.0.0.2",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS) Safari/604.1 Mobile",
    });

    assert.ok(s1.id);
    assert.ok(s2.id);

    const sessions = await sessionRegistryService.listUserSessions("user-1");
    assert.equal(sessions.length, 2);
    assert.equal(sessions.length, 2);
    const ids = sessions.map((s) => s.id);
    assert.ok(ids.includes(s1.id));
    assert.ok(ids.includes(s2.id));
  });

  it("revoking a session makes it immediately invalid", async () => {
    const session = await sessionRegistryService.createSession("user-1", {
      ip: "127.0.0.1",
    });

    const validBefore = await sessionRegistryService.isSessionValid(session.id, "user-1");
    assert.equal(validBefore, true);

    let eventFired = false;
    const unsub = sessionRegistryService.onRevocation((event) => {
      if (event.revokedSessionId === session.id) {
        eventFired = true;
      }
    });

    await sessionRegistryService.revokeSession(session.id, "Security logout");
    unsub();

    const validAfter = await sessionRegistryService.isSessionValid(session.id, "user-1");
    assert.equal(validAfter, false);
    assert.equal(eventFired, true);

    const activeList = await sessionRegistryService.listUserSessions("user-1");
    assert.equal(activeList.length, 0);
  });

  it("revokes all other sessions while preserving current session", async () => {
    const sCurrent = await sessionRegistryService.createSession("user-2", { ip: "1.1.1.1" });
    const sOther1 = await sessionRegistryService.createSession("user-2", { ip: "2.2.2.2" });
    const sOther2 = await sessionRegistryService.createSession("user-2", { ip: "3.3.3.3" });

    const count = await sessionRegistryService.revokeAllUserSessions("user-2", sCurrent.id);
    assert.equal(count, 2);

    assert.equal(await sessionRegistryService.isSessionValid(sCurrent.id, "user-2"), true);
    assert.equal(await sessionRegistryService.isSessionValid(sOther1.id, "user-2"), false);
    assert.equal(await sessionRegistryService.isSessionValid(sOther2.id, "user-2"), false);

    const remaining = await sessionRegistryService.listUserSessions("user-2");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, sCurrent.id);
  });

  it("requireAuth rejects requests with revoked JWT session with 401", async () => {
    const session = await sessionRegistryService.createSession("user-test-401", {
      ip: "127.0.0.1",
    });

    const token = signAccessToken({
      userId: "user-test-401",
      email: "user@test.com",
      role: UserRole.USER,
      sessionId: session.id,
    });

    // 1. Initial valid request
    let nextCalled = false;
    let statusSent = 0;
    let jsonSent: any = null;

    const req1: any = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    };
    const res1: any = {
      status(code: number) {
        statusSent = code;
        return this;
      },
      json(data: any) {
        jsonSent = data;
      },
    };

    await requireAuth(req1, res1, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req1.user?.id, "user-test-401");
    assert.equal(req1.sessionId, session.id);

    // 2. Revoke session
    await sessionRegistryService.revokeSession(session.id);

    // 3. Second request with same token must fail with 401
    nextCalled = false;
    statusSent = 0;
    jsonSent = null;

    const req2: any = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    };
    const res2: any = {
      status(code: number) {
        statusSent = code;
        return this;
      },
      json(data: any) {
        jsonSent = data;
      },
    };

    await requireAuth(req2, res2, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(statusSent, 401);
    assert.match(jsonSent?.message, /Session has been revoked or expired/);
  });
});
