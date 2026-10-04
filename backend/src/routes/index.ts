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
import adminRoutes from "./admin.routes.js";
import analyticsRoutes from "./analytics.routes.js";
import leaderboardRoutes from "./leaderboard.routes.js";
import financialRoutes from "./financial.routes.js";
import sep8Routes from "./sep8.routes.js";
import webhookRoutes from "./webhook.routes.js";

const router = Router();

router.use("/sync", syncRoutes);
router.use("/players", playerRoutes);
router.use("/teams", teamRoutes);
router.use("/gameweeks", gameweekRoutes);
router.use("/fixtures", fixtureRoutes);
router.use("/squads", squadRoutes);
router.use("/leagues", leagueRoutes);
router.use("/auth", authRoutes);
router.use("/live", liveRoutes);
router.use("/admin", adminRoutes);
router.use("/leaderboard", leaderboardRoutes);
router.use("/financial", financialRoutes);
router.use("/sep8", sep8Routes);
router.use("/webhooks", webhookRoutes);

// Read-heavy public data: GET requests may be served by the nearest read replica.
// All other routers (auth, squads, admin, sync) always use the primary database.
apiV1Router.use("/players", replicaReads, playerRoutes);
apiV1Router.use("/teams", replicaReads, teamRoutes);
apiV1Router.use("/gameweeks", replicaReads, gameweekRoutes);
apiV1Router.use("/fixtures", replicaReads, fixtureRoutes);
apiV1Router.use("/squads", squadRoutes);
apiV1Router.use("/leagues", replicaReads, leagueRoutes);
apiV1Router.use("/live", replicaReads, liveRoutes);
// Historical analytics are aggregates of settled scores, so replica lag is harmless
apiV1Router.use("/analytics", replicaReads, analyticsRoutes);
apiV1Router.use("/leaderboard", replicaReads, leaderboardRoutes);

export default apiV1Router;
export default router;
