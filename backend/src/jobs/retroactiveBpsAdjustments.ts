import { prisma } from "../config/db.js";
import { retroactiveBpsAdjustmentService } from "../services/scoring/retroactiveBpsAdjustmentService.js";

/** Official bonus points and stat corrections land within a few days of a gameweek. */
const RECENT_FINISHED_GAMEWEEKS = 2;

/**
 * Retroactive BPS Adjustment Job (issue #266).
 *
 * The live sync stops once every fixture of a gameweek has finished, so later
 * official corrections would never reach the platform. Every 30 minutes this
 * job diffs the most recent finished gameweeks against the FPL API and applies
 * any corrections through the audited differential engine.
 */
export async function applyRetroactiveBpsAdjustments(): Promise<void> {
  const gameweeks = await prisma.gameweek.findMany({
    where: { isFinished: true },
    orderBy: { id: "desc" },
    take: RECENT_FINISHED_GAMEWEEKS,
    select: { id: true, name: true },
  });

  for (const gameweek of gameweeks) {
    const report = await retroactiveBpsAdjustmentService.detectAndApply(gameweek.id);
    if (report.applied) {
      console.log(
        `[jobs] ${gameweek.name}: applied ${report.corrections.length} stat correction(s), ` +
          `${report.squadAdjustments.length} squad score(s) adjusted, ` +
          `${report.protectedLeagues.length} settled league(s) protected (run ${report.runId})`
      );
    }
  }
}
