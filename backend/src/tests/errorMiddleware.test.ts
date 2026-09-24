import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorHandler, AppError } from "../middleware/error.middleware.js";
import { logger } from "../config/logger.js";

describe("Error Tracking and Logging Middleware", () => {
  it("should catch intentional 500 error, log structured details, and format safe response", async () => {
    let loggedObj: any = null;
    let loggedMsg: string | null = null;
    const originalLoggerError = logger.error.bind(logger);

    (logger as any).error = (obj: any, msg?: string) => {
      loggedObj = obj;
      loggedMsg = msg || null;
    };

    try {
      const intentionalError = new Error("Database query failed unexpectedly");
      const req: any = {
        method: "GET",
        url: "/api/v1/players",
        originalUrl: "/api/v1/players",
        ip: "127.0.0.1",
        headers: { "user-agent": "test-agent" },
      };

      let statusReceived: number | null = null;
      let jsonReceived: any = null;

      const res: any = {
        headersSent: false,
        status: (code: number) => {
          statusReceived = code;
          return res;
        },
        json: (data: any) => {
          jsonReceived = data;
          return res;
        },
      };

      const next = () => {};

      errorHandler(intentionalError, req, res, next);

      // Verify HTTP response
      assert.strictEqual(statusReceived, 500);
      assert.strictEqual(jsonReceived.success, false);
      assert.strictEqual(jsonReceived.message, "Database query failed unexpectedly");
      // Verify sensitive stack trace is NOT leaked in response
      assert.strictEqual(jsonReceived.stack, undefined);

      // Verify structured logger received all metadata including stack trace
      assert.ok(loggedObj);
      assert.strictEqual(loggedObj.statusCode, 500);
      assert.strictEqual(loggedObj.err.message, "Database query failed unexpectedly");
      assert.ok(loggedObj.err.stack);
      assert.strictEqual(loggedObj.req.method, "GET");
      assert.strictEqual(loggedObj.req.url, "/api/v1/players");
      assert.strictEqual(loggedObj.req.ip, "127.0.0.1");
      assert.strictEqual(loggedMsg, "Database query failed unexpectedly");
    } finally {
      (logger as any).error = originalLoggerError;
    }
  });

  it("should mask 500 error message in production mode without leaking internal details", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const unhandledError = new Error("Secret database credentials leak in error");
      const req: any = { method: "POST", url: "/api/v1/squads", headers: {} };
      let statusReceived: number | null = null;
      let jsonReceived: any = null;

      const res: any = {
        headersSent: false,
        status: (code: number) => {
          statusReceived = code;
          return res;
        },
        json: (data: any) => {
          jsonReceived = data;
          return res;
        },
      };

      errorHandler(unhandledError, req, res, () => {});

      assert.strictEqual(statusReceived, 500);
      assert.strictEqual(jsonReceived.success, false);
      assert.strictEqual(jsonReceived.message, "Internal server error");
      assert.strictEqual(jsonReceived.stack, undefined);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it("should respect operational status code for custom AppError", async () => {
    const notFoundError = new AppError("Player not found with ID 999", 404);
    const req: any = { method: "GET", url: "/api/v1/players/999", headers: {} };
    let statusReceived: number | null = null;
    let jsonReceived: any = null;

    const res: any = {
      headersSent: false,
      status: (code: number) => {
        statusReceived = code;
        return res;
      },
      json: (data: any) => {
        jsonReceived = data;
        return res;
      },
    };

    errorHandler(notFoundError, req, res, () => {});

    assert.strictEqual(statusReceived, 404);
    assert.strictEqual(jsonReceived.success, false);
    assert.strictEqual(jsonReceived.message, "Player not found with ID 999");
    assert.strictEqual(jsonReceived.stack, undefined);
  });

  it("should delegate to next when response headers have already been sent", async () => {
    let nextCalledWith: any = null;
    const testError = new Error("Late failure");
    const req: any = { headers: {} };
    const res: any = { headersSent: true };
    const next = (err: any) => {
      nextCalledWith = err;
    };

    errorHandler(testError, req, res, next);

    assert.strictEqual(nextCalledWith, testError);
  });
});
