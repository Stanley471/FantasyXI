import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import apiV1Router from "./routes/index.js";
import { startJobQueue, stopJobQueue, getQueueHealth } from "./queues/jobQueue.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/error.middleware.js";

dotenv.config();

const app = express();

// Trust reverse proxies (Cloudflare, Nginx, ALB) for accurate client IP rate limiting
app.set("trust proxy", 1);

// ============================================================
// Middleware
// ============================================================

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
app.use(apiRateLimiter);

// ============================================================
// Routes
// ============================================================

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "FantasyXI API",
    version: "0.2.0",
    status: "running",
  });
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "FantasyXI API is running",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health/queues", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const health = await getQueueHealth();
    res.status(health.running ? 200 : 503).json({
      success: health.running,
      data: health,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// API v1 Routes
app.use("/api/v1", apiV1Router);
app.use("/api", apiV1Router);


// ============================================================
// Global error handler
// ============================================================

app.use(errorHandler);

// ============================================================
// Start server
// ============================================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`
  ⚽ FantasyXI API Server
  ────────────────────────
  Port:     ${PORT}
  Env:      ${process.env.NODE_ENV || "development"}
  URL:      http://localhost:${PORT}
  Health:   http://localhost:${PORT}/api/health
  `);

  // Background jobs (set JOB_QUEUE_ENABLED=false to run the API without workers)
  if (process.env.DATABASE_URL && process.env.JOB_QUEUE_ENABLED !== "false") {
    startJobQueue(process.env.DATABASE_URL).catch((error) =>
      console.error("[jobs] Failed to start job queue:", error)
    );
  }
});

process.on("SIGTERM", () => {
  stopJobQueue().finally(() => process.exit(0));
});