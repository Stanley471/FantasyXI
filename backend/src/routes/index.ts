import { Router } from "express";
import syncRoutes from "./sync.routes.js";
import playerRoutes from "./player.routes.js";
import teamRoutes from "./team.routes.js";
import gameweekRoutes from "./gameweek.routes.js";
import fixtureRoutes from "./fixture.routes.js";
import squadRoutes from "./squad.routes.js";
import leagueRoutes from "./league.routes.js";
import authRoutes from "./auth.routes.js";
import liveRoutes from "./live.routes.js";
import ledgerAuditRoutes from "./ledgerAudit.routes.js";
import adminRoutes from "./admin.routes.js";
import analyticsRoutes from "./analytics.routes.js";
import leaderboardRoutes from "./leaderboard.routes.js";
import financialRoutes from "./financial.routes.js";
import sep8Routes from "./sep8.routes.js";
import webhookRoutes from "./webhook.routes.js";
import { replicaReads } from "../middleware/readConsistency.js";
import { fplDataFreshness } from "../middleware/fplDataFreshness.js";

/**
 * Main API v1 router.
 *
 * Laravel equivalent: routes/api.php route groups with prefix 'v1'.
 */
const apiV1Router = Router();

apiV1Router.use("/auth", authRoutes);
apiV1Router.use("/admin/sync", syncRoutes);
apiV1Router.use("/admin/ledger-audits", ledgerAuditRoutes);
apiV1Router.use("/players", playerRoutes);
apiV1Router.use("/teams", teamRoutes);
apiV1Router.use("/gameweeks", gameweekRoutes);
apiV1Router.use("/fixtures", fixtureRoutes);
apiV1Router.use("/sync", fplDataFreshness, syncRoutes);
apiV1Router.use("/admin/sync", fplDataFreshness, syncRoutes);
apiV1Router.use("/admin", adminRoutes);
apiV1Router.use("/sep8", sep8Routes);
apiV1Router.use("/financial", financialRoutes);
apiV1Router.use("/webhooks", webhookRoutes);

// Read-heavy public data: GET requests may be served by the nearest read replica.
// All other routers (auth, squads, admin, sync) always use the primary database.
// FPL-synced data keeps being served while the FPL circuit is open, flagged X-Data-Stale
apiV1Router.use("/players", replicaReads, fplDataFreshness, playerRoutes);
apiV1Router.use("/teams", replicaReads, teamRoutes);
apiV1Router.use("/gameweeks", replicaReads, gameweekRoutes);
apiV1Router.use("/fixtures", replicaReads, fplDataFreshness, fixtureRoutes);
apiV1Router.use("/squads", squadRoutes);
apiV1Router.use("/leagues", replicaReads, leagueRoutes);
apiV1Router.use("/live", replicaReads, liveRoutes);
// Historical analytics are aggregates of settled scores, so replica lag is harmless
apiV1Router.use("/analytics", replicaReads, analyticsRoutes);
apiV1Router.use("/leaderboard", replicaReads, leaderboardRoutes);

export default apiV1Router;
