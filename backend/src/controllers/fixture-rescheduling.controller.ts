import { Router, type Request, type Response } from "express";
import { fixtureReschedulingEngine } from "../services/fpl/fixtureReschedulingEngine.js";
import { fixtureReschedulingReconciler } from "../services/fpl/fixtureReschedulingReconciler.js";
import { varRollbackRecalculator } from "../services/live/varRollbackRecalculator.js";
import { liveMatchEventAggregator } from "../services/live/liveMatchEventAggregator.js";
import { sequenceTracker } from "../services/live/sequenceTracker.js";
import { requireAdmin } from "../middleware/authorization.js";

const router = Router();

router.post("/fixtures/reschedule", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { fixtures } = req.body;

    if (!Array.isArray(fixtures)) {
      return res.status(400).json({ error: "fixtures must be an array" });
    }

    const analysis = await fixtureReschedulingEngine.parseRescheduleAnnouncement(
      fixtures
    );
    const dgwTeams = await fixtureReschedulingEngine.identifyDoubleGameweeks(
      fixtures
    );
    const deadlineAdjustments =
      await fixtureReschedulingEngine.applyDynamicDeadlineAdjustments(fixtures);
    const rescheduledCount =
      await fixtureReschedulingEngine.applyRescheduledFixtures(fixtures);

    return res.status(200).json({
      success: true,
      rescheduledCount,
      blankGameweekAnalysis: analysis,
      doubleGameweeks: dgwTeams,
      deadlineAdjustments,
    });
  } catch (error) {
    console.error("[FixtureRescheduling]", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/fixtures/reconcile", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { fixtures } = req.body;

    if (!Array.isArray(fixtures)) {
      return res.status(400).json({ error: "fixtures must be an array" });
    }

    const report = await fixtureReschedulingReconciler.reconcileFixtureChanges(
      fixtures
    );

    return res.status(200).json({
      success: true,
      report,
    });
  } catch (error) {
    console.error("[FixtureReconciliation]", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/match-event", requireAdmin, async (req: Request, res: Response) => {
  try {
    const event = req.body;

    if (
      !event.eventId ||
      !event.fixtureId ||
      !event.playerId ||
      !event.eventType
    ) {
      return res.status(400).json({ error: "Missing required event fields" });
    }

    const affectedSquads = await liveMatchEventAggregator.processLiveEvent(event);

    return res.status(200).json({
      success: true,
      affectedSquadsCount: affectedSquads.length,
      affectedSquads,
    });
  } catch (error) {
    console.error("[LiveMatchEvent]", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/var-rollback", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { fixtureId, playerId, adjustment, leagueId } = req.body;

    if (!fixtureId || !playerId || !adjustment) {
      return res.status(400).json({
        error: "fixtureId, playerId, and adjustment are required",
      });
    }

    const rollbackReport = await varRollbackRecalculator.processRetroactiveAdjustment(
      fixtureId,
      playerId,
      adjustment
    );

    if (leagueId) {
      await varRollbackRecalculator.recalculateLeagueStandings(
        leagueId,
        (await (await import("../config/db.js")).prisma.fixture.findUnique({
          where: { id: fixtureId },
          select: { gameweekId: true },
        }))?.gameweekId ?? 0
      );
    }

    return res.status(200).json({
      success: true,
      report: rollbackReport,
    });
  } catch (error) {
    console.error("[VARRollback]", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sequence/:channel/backfill", async (req: Request, res: Response) => {
  try {
    const { channel } = req.params;
    const { lastSeenSequence } = req.query;

    if (!channel) {
      return res.status(400).json({ error: "channel is required" });
    }

    const lastSeen = lastSeenSequence ? parseInt(lastSeenSequence as string, 10) : 0;
    const backfill = await sequenceTracker.getBackfillWindow(channel, lastSeen);

    return res.status(200).json({
      success: true,
      channel,
      lastSeenSequence: lastSeen,
      events: backfill,
      count: backfill.length,
    });
  } catch (error) {
    console.error("[SequenceBackfill]", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sequence/:channel/current", async (req: Request, res: Response) => {
  try {
    const { channel } = req.params;

    if (!channel) {
      return res.status(400).json({ error: "channel is required" });
    }

    const currentSeq = await sequenceTracker.getLastSequenceNumber(channel);

    return res.status(200).json({
      success: true,
      channel,
      currentSequence: currentSeq,
    });
  } catch (error) {
    console.error("[SequenceQuery]", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/live-rankings/:fixtureId", async (req: Request, res: Response) => {
  try {
    const { fixtureId } = req.params;

    if (!fixtureId) {
      return res.status(400).json({ error: "fixtureId is required" });
    }

    const ranks = await liveMatchEventAggregator.getLeagueRanks(
      "default",
      parseInt(fixtureId as string, 10)
    );
    const history = await liveMatchEventAggregator.getEventHistory(
      parseInt(fixtureId as string, 10)
    );

    return res.status(200).json({
      success: true,
      fixtureId,
      rankings: ranks,
      eventHistory: history,
    });
  } catch (error) {
    console.error("[LiveRankings]", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
