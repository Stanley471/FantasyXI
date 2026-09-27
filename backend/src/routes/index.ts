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

export default router;
