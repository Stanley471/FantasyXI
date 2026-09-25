import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import app from "./app.js";
import { startJobQueue, stopJobQueue, getQueueHealth } from "./queues/jobQueue.js";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import DataLoader from "dataloader";
import { prisma } from "./config/db.js";
import { resolvers } from "./graphql/resolvers.js";
import { typeDefs } from "./graphql/schema.js";

dotenv.config();

const apolloServer = new ApolloServer({ typeDefs, resolvers });

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

// ============================================================
// Start server
// ============================================================

const PORT = process.env.PORT || 5000;

async function startServer(): Promise<void> {
  await apolloServer.start();
  app.use(
    "/graphql",
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
  stopJobQueue().finally(() => process.exit(0));
});
