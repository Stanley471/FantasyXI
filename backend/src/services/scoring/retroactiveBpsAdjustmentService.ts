import crypto from "crypto";

export interface PlayerBpsSnapshot {
  playerId: number;
  fixtureId: number;
  gameweekId: number;
  minutes: number;
  bps: number;
  bonus: number;
  basePointsWithoutBonus: number;
  totalPoints: number;
}

export interface PlayerStatDelta {
  playerId: number;
  fixtureId: number;
  gameweekId: number;
  bpsBefore: number;
  bpsAfter: number;
  bonusBefore: number;
  bonusAfter: number;
  totalPointsBefore: number;
  totalPointsAfter: number;
  pointsDelta: number;
}

export interface SquadOwnershipSlot {
  playerId: number;
  isStarter: boolean;
  /** 1 = starter, 2 = Captain, 3 = Triple Captain */
  multiplier: number;
}

export interface LeagueSquadStandingState {
  squadId: string;
  userId: string;
  gameweekPoints: number;
  totalSeasonPoints: number;
  rank: number;
  lineup: SquadOwnershipSlot[];
}

export interface LeagueAdjustmentTarget {
  leagueId: string;
  leagueName: string;
  onChainSettled: boolean;
  settlementTxHash?: string | null;
  squads: LeagueSquadStandingState[];
}

export interface SquadAdjustmentDiff {
  leagueId: string;
  squadId: string;
  userId: string;
  gameweekPointsBefore: number;
  gameweekPointsAfter: number;
  totalSeasonPointsBefore: number;
  totalSeasonPointsAfter: number;
  pointsDelta: number;
  rankBefore: number;
  rankAfter: number;
}

export interface PostSettlementDiscrepancyAlert {
  alertType: "POST_SETTLEMENT_STAT_DISCREPANCY";
  leagueId: string;
  leagueName: string;
  settlementTxHash: string | null;
  gameweekId: number;
  wouldAffectSquads: SquadAdjustmentDiff[];
  detectedAt: Date;
}

export interface RetroactiveScoreAuditRecord {
  auditId: string;
  gameweekId: number;
  fixtureId: number;
  reason: string;
  playerDeltas: PlayerStatDelta[];
  appliedSquadDiffs: SquadAdjustmentDiff[];
  postSettlementAlerts: PostSettlementDiscrepancyAlert[];
  createdAt: Date;
}

export class RetroactiveBpsAdjustmentService {
  private readonly auditLog: RetroactiveScoreAuditRecord[] = [];

  /**
   * Computes official FPL bonus points (3, 2, 1) from raw BPS scores in a single fixture,
   * strictly enforcing official FPL tie-breaking rules:
   * - Tie for 1st (2 players): both get 3, next gets 1
   * - Tie for 1st (3+ players): all tied get 3, no 2 or 1 awarded
   * - Tie for 2nd (2+ players): 1st gets 3, all tied for 2nd get 2, no 1 awarded
   * - Tie for 3rd (2+ players): 1st gets 3, 2nd gets 2, all tied for 3rd get 1
   */
  public static allocateFixtureBonusPoints(
    players: Array<{ playerId: number; minutes: number; bps: number }>
  ): Map<number, number> {
    const bonusMap = new Map<number, number>();
    for (const p of players) {
      bonusMap.set(p.playerId, 0);
    }

    const eligible = players
      .filter((p) => p.minutes > 0 && p.bps > 0)
      .sort((a, b) => b.bps - a.bps || a.playerId - b.playerId);

    if (eligible.length === 0) {
      return bonusMap;
    }

    // Group eligible players by distinct BPS score in descending order
    const bpsGroups: Array<{ bps: number; playerIds: number[] }> = [];
    for (const p of eligible) {
      const lastGroup = bpsGroups[bpsGroups.length - 1];
      if (lastGroup && lastGroup.bps === p.bps) {
        lastGroup.playerIds.push(p.playerId);
      } else {
        bpsGroups.push({ bps: p.bps, playerIds: [p.playerId] });
      }
    }

    // 1st group always receives 3 bonus points
    const firstGroup = bpsGroups[0];
    for (const pid of firstGroup.playerIds) {
      bonusMap.set(pid, 3);
    }

    if (firstGroup.playerIds.length >= 3) {
      return bonusMap;
    }

    if (firstGroup.playerIds.length === 2) {
      // Next group receives 1 bonus point
      if (bpsGroups[1]) {
        for (const pid of bpsGroups[1].playerIds) {
          bonusMap.set(pid, 1);
        }
      }
      return bonusMap;
    }

    // firstGroup had exactly 1 player -> check 2nd group (receives 2 bonus points)
    const secondGroup = bpsGroups[1];
    if (!secondGroup) {
      return bonusMap;
    }
    for (const pid of secondGroup.playerIds) {
      bonusMap.set(pid, 2);
    }

    if (secondGroup.playerIds.length >= 2) {
      // Tie for 2nd place means no 1-point bonus is awarded
      return bonusMap;
    }

    // Both 1st and 2nd had single players -> 3rd group receives 1 bonus point
    const thirdGroup = bpsGroups[2];
    if (thirdGroup) {
      for (const pid of thirdGroup.playerIds) {
        bonusMap.set(pid, 1);
      }
    }

    return bonusMap;
  }

  /**
   * Recalculates fixture bonus points and stat corrections, propagates deltas to
   * unsettled leagues (updating squad scores and ranks atomically), blocks mutations
   * on already on-chain settled leagues while emitting discrepancy alerts, and records
   * an immutable state diff audit trail.
   */
  public applyRetroactiveFixtureAdjustment(params: {
    gameweekId: number;
    fixtureId: number;
    reason: string;
    previousStats: PlayerBpsSnapshot[];
    updatedRawStats: Array<{
      playerId: number;
      minutes: number;
      bps: number;
      basePointsWithoutBonus: number;
    }>;
    leagues: LeagueAdjustmentTarget[];
    now?: Date;
  }): RetroactiveScoreAuditRecord {
    const now = params.now ?? new Date();
    const prevByPlayer = new Map<number, PlayerBpsSnapshot>();
    for (const st of params.previousStats) {
      prevByPlayer.set(st.playerId, st);
    }

    const newBonusMap = RetroactiveBpsAdjustmentService.allocateFixtureBonusPoints(
      params.updatedRawStats
    );

    const playerDeltas: PlayerStatDelta[] = [];
    const pointsDeltaByPlayer = new Map<number, number>();

    for (const updated of params.updatedRawStats) {
      const prev = prevByPlayer.get(updated.playerId);
      if (!prev) continue;

      const bonusAfter = newBonusMap.get(updated.playerId) ?? 0;
      const totalPointsAfter = updated.basePointsWithoutBonus + bonusAfter;
      const pointsDelta = totalPointsAfter - prev.totalPoints;

      if (
        prev.bps !== updated.bps ||
        prev.bonus !== bonusAfter ||
        pointsDelta !== 0
      ) {
        playerDeltas.push({
          playerId: updated.playerId,
          fixtureId: params.fixtureId,
          gameweekId: params.gameweekId,
          bpsBefore: prev.bps,
          bpsAfter: updated.bps,
          bonusBefore: prev.bonus,
          bonusAfter,
          totalPointsBefore: prev.totalPoints,
          totalPointsAfter,
          pointsDelta,
        });
      }

      if (pointsDelta !== 0) {
        pointsDeltaByPlayer.set(updated.playerId, pointsDelta);
      }
    }

    const appliedSquadDiffs: SquadAdjustmentDiff[] = [];
    const postSettlementAlerts: PostSettlementDiscrepancyAlert[] = [];

    for (const league of params.leagues) {
      // Ensure baseline ranks are sorted before applying deltas
      this.rankLeagueSquads(league.squads);
      const beforeSnapshots = new Map<
        string,
        { gwPts: number; totalPts: number; rank: number }
      >();

      for (const sq of league.squads) {
        beforeSnapshots.set(sq.squadId, {
          gwPts: sq.gameweekPoints,
          totalPts: sq.totalSeasonPoints,
          rank: sq.rank,
        });
      }

      // Compute simulated state
      const simulatedSquads = league.squads.map((sq) => {
        let squadDelta = 0;
        for (const slot of sq.lineup) {
          if (!slot.isStarter || slot.multiplier <= 0) continue;
          const pDelta = pointsDeltaByPlayer.get(slot.playerId) ?? 0;
          squadDelta += pDelta * slot.multiplier;
        }
        return {
          ...sq,
          gameweekPoints: sq.gameweekPoints + squadDelta,
          totalSeasonPoints: sq.totalSeasonPoints + squadDelta,
          _delta: squadDelta,
        };
      });

      this.rankLeagueSquads(simulatedSquads);

      const leagueDiffs: SquadAdjustmentDiff[] = [];
      for (const sim of simulatedSquads) {
        const before = beforeSnapshots.get(sim.squadId)!;
        if (sim._delta !== 0 || sim.rank !== before.rank) {
          leagueDiffs.push({
            leagueId: league.leagueId,
            squadId: sim.squadId,
            userId: sim.userId,
            gameweekPointsBefore: before.gwPts,
            gameweekPointsAfter: sim.gameweekPoints,
            totalSeasonPointsBefore: before.totalPts,
            totalSeasonPointsAfter: sim.totalSeasonPoints,
            pointsDelta: sim._delta,
            rankBefore: before.rank,
            rankAfter: sim.rank,
          });
        }
      }

      if (leagueDiffs.length === 0) {
        continue;
      }

      // Block mutation if the league has already settled prizes on-chain
      if (league.onChainSettled) {
        postSettlementAlerts.push({
          alertType: "POST_SETTLEMENT_STAT_DISCREPANCY",
          leagueId: league.leagueId,
          leagueName: league.leagueName,
          settlementTxHash: league.settlementTxHash ?? null,
          gameweekId: params.gameweekId,
          wouldAffectSquads: leagueDiffs,
          detectedAt: now,
        });
        continue;
      }

      // Commit mutations to unsettled league squads
      for (const sim of simulatedSquads) {
        const target = league.squads.find((s) => s.squadId === sim.squadId)!;
        target.gameweekPoints = sim.gameweekPoints;
        target.totalSeasonPoints = sim.totalSeasonPoints;
        target.rank = sim.rank;
      }
      league.squads.sort((a, b) => a.rank - b.rank);
      appliedSquadDiffs.push(...leagueDiffs);
    }

    const auditRecord: RetroactiveScoreAuditRecord = {
      auditId: crypto.randomUUID(),
      gameweekId: params.gameweekId,
      fixtureId: params.fixtureId,
      reason: params.reason,
      playerDeltas,
      appliedSquadDiffs,
      postSettlementAlerts,
      createdAt: now,
    };

    this.auditLog.push(auditRecord);
    return auditRecord;
  }

  public getAuditLog(): ReadonlyArray<RetroactiveScoreAuditRecord> {
    return this.auditLog;
  }

  private rankLeagueSquads(
    squads: Array<{
      squadId: string;
      totalSeasonPoints: number;
      gameweekPoints: number;
      rank: number;
    }>
  ): void {
    squads.sort((a, b) => {
      if (b.totalSeasonPoints !== a.totalSeasonPoints) {
        return b.totalSeasonPoints - a.totalSeasonPoints;
      }
      if (b.gameweekPoints !== a.gameweekPoints) {
        return b.gameweekPoints - a.gameweekPoints;
      }
      return a.squadId.localeCompare(b.squadId);
    });
    squads.forEach((sq, idx) => {
      sq.rank = idx + 1;
    });
  }
}

export const retroactiveBpsAdjustmentService =
  new RetroactiveBpsAdjustmentService();
