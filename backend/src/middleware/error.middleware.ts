import { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger.js";
import { redactText, redactValue } from "../services/security/secretScanner.js";

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const statusCode =
    typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.status === "number"
      ? err.status
      : 500;

  // Secrets must never leak through a log record or an error response:
  // sanitize the logged object (message, stack, request url — a query
  // string can carry a token) and the response message. The logger's own
  // hook redacts again as defense in depth; this explicit pass is what
  // protects callers that bypass the hook.
  const sanitizedLog = redactValue({
    err: {
      name: err?.name || "Error",
      message: err?.message || "Unknown error",
      stack: err?.stack,
    },
    req: {
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip,
      headers: {
        "user-agent": req.headers?.["user-agent"],
        "x-forwarded-for": req.headers?.["x-forwarded-for"],
      },
    },
    statusCode,
  });

  logger.error(sanitizedLog, redactText(err?.message || "Unhandled server error"));

  const isProduction = process.env.NODE_ENV === "production";
  const message =
    statusCode >= 500 && isProduction
      ? "Internal server error"
      : redactText(err?.message || "Internal server error");

  res.status(statusCode).json({
    success: false,
    message,
  });
}
