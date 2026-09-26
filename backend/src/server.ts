import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import apiV1Router from "./routes/index.js";
import { startJobQueue, stopJobQueue, getQueueHealth } from "./queues/jobQueue.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import DataLoader from "dataloader";
import { prisma, getReadReplicaStatus } from "./config/db.js";
import { closeRedisClient } from "./config/redis.js";
import { preferReplicaReads } from "./middleware/readConsistency.js";
import { financialAuditLog } from "./services/audit/financialAuditLog.js";
import { resolvers } from "./graphql/resolvers.js";
import { typeDefs } from "./graphql/schema.js";

dotenv.config();

const app = express();
const apolloServer = new ApolloServer({ typeDefs, resolvers });

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

app.get("/api/health/replicas", (_req: Request, res: Response) => {
  const replicas = getReadReplicaStatus();
  res.json({
    success: true,
    data: {
      enabled: replicas.length > 0,
      appRegion: process.env.APP_REGION ?? null,
      replicas,
    },
    timestamp: new Date().toISOString(),
  });
});

// API v1 Routes
app.use("/api/v1", apiV1Router);
app.use("/api", apiV1Router);


// ============================================================
// Global error handler
// ============================================================

/**
 * Express error-handling middleware.
 *
 * Laravel equivalent: This is like your app/Exceptions/Handler.php —
 * a single place that catches all unhandled errors and returns a
 * consistent JSON response.
 *
 * The 4-parameter signature (err, req, res, next) tells Express
 * this is an error handler, not a regular middleware.
 */
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

// ============================================================
// Start server
// ============================================================

const PORT = process.env.PORT || 5000;

async function startServer(): Promise<void> {
  await apolloServer.start();
  app.use(
    "/graphql",
    // The schema is query-only, so GraphQL reads may be served by a replica
    preferReplicaReads,
    express.json(),
    expressMiddleware(apolloServer, {
      context: async () => ({
        loaders: {
          users: new DataLoader(async (ids) => {
            const records = await prisma.user.findMany({
              where: { id: { in: [...ids].map(String) } },
              include: { wallet: true, squads: true, createdLeagues: true },
            });
            const byId = new Map(records.map((record) => [record.id, record]));
            return ids.map((id) => byId.get(String(id)) ?? null);
          }),
          players: new DataLoader(async (ids) => {
            const records = await prisma.player.findMany({
              where: { id: { in: [...ids].map(Number) } },
              include: { team: true },
            });
            const byId = new Map(records.map((record) => [record.id, record]));
            return ids.map((id) => byId.get(Number(id)) ?? null);
          }),
        },
      }),
    }),
  );

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
}

startServer().catch((error) => {
  console.error("Failed to start FantasyXI API:", error);
  process.exitCode = 1;
});

process.on("SIGTERM", () => {
  // Persist buffered financial audit entries before exiting
  stopJobQueue()
    .finally(() => financialAuditLog.close())
    .finally(() => closeRedisClient())
    .finally(() => process.exit(0));
});
