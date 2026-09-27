import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import apiV1Router from "./routes/index.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";

dotenv.config();

const app = express();

// Trust reverse proxies (Cloudflare, Nginx, ALB) for accurate client IP rate limiting
app.set("trust proxy", 1);

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
app.use(apiRateLimiter);

// Health check routes
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

// API v1 Routes
app.use("/api/v1", apiV1Router);
app.use("/api", apiV1Router);

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);

  res.status(500).json({
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
});

export default app;
