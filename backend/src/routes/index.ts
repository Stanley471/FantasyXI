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

/**
 * Main API v1 router.
 *
 * Laravel equivalent: routes/api.php route groups with prefix 'v1'.
 */
const apiV1Router = Router();

apiV1Router.use("/auth", authRoutes);
apiV1Router.use("/admin/sync", syncRoutes);
apiV1Router.use("/players", playerRoutes);
apiV1Router.use("/teams", teamRoutes);
apiV1Router.use("/gameweeks", gameweekRoutes);
apiV1Router.use("/fixtures", fixtureRoutes);
apiV1Router.use("/squads", squadRoutes);
apiV1Router.use("/leagues", leagueRoutes);
apiV1Router.use("/live", liveRoutes);

export default apiV1Router;
