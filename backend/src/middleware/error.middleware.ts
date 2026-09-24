import { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger.js";

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

  logger.error(
    {
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
    },
    err?.message || "Unhandled server error"
  );

  const isProduction = process.env.NODE_ENV === "production";
  const message =
    statusCode >= 500 && isProduction
      ? "Internal server error"
      : err?.message || "Internal server error";

  res.status(statusCode).json({
    success: false,
    message,
  });
}
