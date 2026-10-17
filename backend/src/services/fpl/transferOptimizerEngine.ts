import crypto from "crypto";
import { Position, SQUAD_RULES } from "../../types/index.js";

export interface OptimizableSquadPlayer {
  playerId: number;
  name: string;
  teamId: number;
  position: Position;
  purchasePrice: number; // in 0.1m units (e.g. 100 = 10.0m) or decimal millions
  currentPrice: number;
}

export interface MarketCandidatePlayer {
  playerId: number;
  name: string;
  teamId: number;
  position: Position;
  currentPrice: number;
  /** Map of gameweekId -> expected points (xPts) */
  expectedPointsByGw: Record<number, number>;
}

export interface PlannedTransferMove {
  playerOutId: number;
  playerOutName: string;
  playerInId: number;
  playerInName: string;
  position: Position;
  sellingPrice: number;
  purchasePrice: number;
  netCost: number;
}

export interface GameweekTransferStep {
  gameweekId: number;
  freeTransfersAvailable: number;
  transfersMade: PlannedTransferMove[];
  pointsHit: number;
  freeTransfersCarriedForward: number;
  remainingBank: number;
  startingPlayerIds: number[];
  captainPlayerId: number;
  viceCaptainPlayerId: number;
  grossExpectedPoints: number;
  netExpectedPoints: number;
}

export interface MultiGwTransferPlan {
  planHash: string;
  horizonGameweeks: number[];
  initialBank: number;
  finalBank: number;
  totalTransfers: number;
  totalPointsHit: number;
  totalGrossExpectedPoints: number;
  totalNetExpectedPoints: number;
  steps: GameweekTransferStep[];
}

export interface TransferOptimizerOptions {
  /** Gameweek IDs in chronological order (1 to 5 gameweeks) */
  horizonGameweeks: number[];
  initialFreeTransfers: number;
  initialBank: number;
  maxTransfersPerGameweek?: number;
  beamWidth?: number;
}

interface BeamNode {
  squad: OptimizableSquadPlayer[];
  bank: number;
  freeTransfers: number;
  steps: GameweekTransferStep[];
  cumulativeNetExpectedPoints: number;
}

export class TransferOptimizerEngine {
  private readonly planCache = new Map<string, MultiGwTransferPlan>();

  /**
   * Computes FPL selling price: managers keep 50% of price rises (rounded down to nearest 0.1m),
   * or absorb the full drop if currentPrice < purchasePrice.
   */
  public static calculateSellingPrice(
    purchasePrice: number,
    currentPrice: number
  ): number {
    if (currentPrice <= purchasePrice) {
      return currentPrice;
    }
    // Support both integer tenths (e.g. 100 = £10.0m) and decimal millions (e.g. 10.0)
    const isTenths =
      Number.isInteger(purchasePrice) &&
      Number.isInteger(currentPrice) &&
      (purchasePrice >= 30 || currentPrice >= 30);

    if (isTenths) {
      const profit = currentPrice - purchasePrice;
      return purchasePrice + Math.floor(profit / 2);
    }

    const profitTenths = Math.round((currentPrice - purchasePrice) * 10);
    const sellGainTenths = Math.floor(profitTenths / 2);
    return Number((purchasePrice + sellGainTenths / 10).toFixed(1));
  }

  /**
   * Selects the highest-scoring valid starting XI (1 GKP, >=3 DEF, >=2 MID, >=1 FWD)
   * and assigns Captain (2x) and Vice-Captain from a 15-man squad for a given gameweek.
   */
  public static selectOptimalLineupForGameweek(
    squad: OptimizableSquadPlayer[],
    marketById: Map<number, MarketCandidatePlayer>,
    gameweekId: number
  ): {
    startingPlayerIds: number[];
    captainPlayerId: number;
    viceCaptainPlayerId: number;
    grossExpectedPoints: number;
  } {
    const scored = squad.map((p) => {
      const xPts = marketById.get(p.playerId)?.expectedPointsByGw[gameweekId] ?? 0;
      return { player: p, xPts };
    });

    const gkps = scored
      .filter((s) => s.player.position === Position.GKP)
      .sort((a, b) => b.xPts - a.xPts);
    const defs = scored
      .filter((s) => s.player.position === Position.DEF)
      .sort((a, b) => b.xPts - a.xPts);
    const mids = scored
      .filter((s) => s.player.position === Position.MID)
      .sort((a, b) => b.xPts - a.xPts);
    const fwds = scored
      .filter((s) => s.player.position === Position.FWD)
      .sort((a, b) => b.xPts - a.xPts);

    const starters: Array<{ player: OptimizableSquadPlayer; xPts: number }> = [];
    const usedIds = new Set<number>();

    const takeTop = (
      list: Array<{ player: OptimizableSquadPlayer; xPts: number }>,
      count: number
    ) => {
      for (let i = 0; i < Math.min(count, list.length); i++) {
        starters.push(list[i]);
        usedIds.add(list[i].player.playerId);
      }
    };

    // Mandatory minimums: 1 GKP, 3 DEF, 2 MID, 1 FWD (= 7 players)
    takeTop(gkps, SQUAD_RULES.MIN_STARTERS.GKP);
    takeTop(defs, SQUAD_RULES.MIN_STARTERS.DEF);
    takeTop(mids, SQUAD_RULES.MIN_STARTERS.MID);
    takeTop(fwds, SQUAD_RULES.MIN_STARTERS.FWD);

    // Fill remaining 4 outfield slots with highest xPts remaining outfielders
    const remainingOutfield = scored
      .filter(
        (s) =>
          s.player.position !== Position.GKP && !usedIds.has(s.player.playerId)
      )
      .sort((a, b) => b.xPts - a.xPts);

    const targetStarters = Math.min(11, squad.length);
    for (const candidate of remainingOutfield) {
      if (starters.length >= targetStarters) break;
      starters.push(candidate);
      usedIds.add(candidate.player.playerId);
    }

    starters.sort((a, b) => b.xPts - a.xPts);
    const captain = starters[0];
    const vice = starters[1] ?? starters[0];

    const baseSum = starters.reduce((sum, s) => sum + s.xPts, 0);
    const grossExpectedPoints = Number(
      (baseSum + (captain ? captain.xPts : 0)).toFixed(2)
    );

    return {
      startingPlayerIds: starters.map((s) => s.player.playerId),
      captainPlayerId: captain ? captain.player.playerId : 0,
      viceCaptainPlayerId: vice ? vice.player.playerId : 0,
      grossExpectedPoints,
    };
  }

  /**
   * Solves for the multi-gameweek transfer plan that maximizes cumulative net expected points
   * (gross expected points minus -4 point hits) over a 1 to 5 gameweek horizon using beam search.
   */
  public optimizeTransferPlan(
    initialSquad: OptimizableSquadPlayer[],
    marketPlayers: MarketCandidatePlayer[],
    options: TransferOptimizerOptions
  ): MultiGwTransferPlan {
    if (
      options.horizonGameweeks.length === 0 ||
      options.horizonGameweeks.length > 5
    ) {
      throw new Error("horizonGameweeks must contain between 1 and 5 gameweeks");
    }

    const cacheKey = this.computeCacheKey(initialSquad, marketPlayers, options);
    const cached = this.planCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const marketById = new Map<number, MarketCandidatePlayer>();
    for (const mp of marketPlayers) {
      marketById.set(mp.playerId, mp);
    }

    const beamWidth = options.beamWidth ?? 8;
    const maxTransfersPerGw = options.maxTransfersPerGameweek ?? 2;

    let beam: BeamNode[] = [
      {
        squad: initialSquad.map((p) => ({ ...p })),
        bank: options.initialBank,
        freeTransfers: Math.min(5, Math.max(1, options.initialFreeTransfers)),
        steps: [],
        cumulativeNetExpectedPoints: 0,
      },
    ];

    for (const gwId of options.horizonGameweeks) {
      const nextBeamCandidates: BeamNode[] = [];

      for (const node of beam) {
        const actionCandidates = this.generateGameweekActions(
          node,
          marketPlayers,
          marketById,
          gwId,
          maxTransfersPerGw
        );
        nextBeamCandidates.push(...actionCandidates);
      }

      nextBeamCandidates.sort((a, b) => {
        if (b.cumulativeNetExpectedPoints !== a.cumulativeNetExpectedPoints) {
          return b.cumulativeNetExpectedPoints - a.cumulativeNetExpectedPoints;
        }
        return b.bank - a.bank;
      });

      beam = nextBeamCandidates.slice(0, beamWidth);
    }

    const best = beam[0];
    const totalTransfers = best.steps.reduce(
      (sum, s) => sum + s.transfersMade.length,
      0
    );
    const totalPointsHit = best.steps.reduce((sum, s) => sum + s.pointsHit, 0);
    const totalGross = Number(
      best.steps
        .reduce((sum, s) => sum + s.grossExpectedPoints, 0)
        .toFixed(2)
    );
    const totalNet = Number((totalGross - totalPointsHit).toFixed(2));

    const plan: MultiGwTransferPlan = {
      planHash: cacheKey,
      horizonGameweeks: [...options.horizonGameweeks],
      initialBank: options.initialBank,
      finalBank: best.bank,
      totalTransfers,
      totalPointsHit,
      totalGrossExpectedPoints: totalGross,
      totalNetExpectedPoints: totalNet,
      steps: best.steps,
    };

    this.planCache.set(cacheKey, plan);
    return plan;
  }

  public clearCache(): void {
    this.planCache.clear();
  }

  public getCacheSize(): number {
    return this.planCache.size;
  }

  private generateGameweekActions(
    node: BeamNode,
    marketPlayers: MarketCandidatePlayer[],
    marketById: Map<number, MarketCandidatePlayer>,
    gameweekId: number,
    maxTransfersPerGw: number
  ): BeamNode[] {
    const results: BeamNode[] = [];

    // Option 0: Roll transfer (0 transfers made)
    results.push(this.buildNextNode(node, [], marketById, gameweekId));

    // Pre-rank market candidates by expected points over remaining horizon from this GW
    const topMarketByPos = new Map<Position, MarketCandidatePlayer[]>();
    for (const pos of [Position.GKP, Position.DEF, Position.MID, Position.FWD]) {
      const candidates = marketPlayers
        .filter((m) => m.position === pos)
        .sort(
          (a, b) =>
            (b.expectedPointsByGw[gameweekId] ?? 0) -
            (a.expectedPointsByGw[gameweekId] ?? 0)
        )
        .slice(0, 6);
      topMarketByPos.set(pos, candidates);
    }

    // Option 1: Single transfers (1 transfer)
    const singleTransferNodes: BeamNode[] = [];
    for (const outPlayer of node.squad) {
      const sellPrice = TransferOptimizerEngine.calculateSellingPrice(
        outPlayer.purchasePrice,
        outPlayer.currentPrice
      );
      const candidates = topMarketByPos.get(outPlayer.position) ?? [];

      for (const inCandidate of candidates) {
        if (node.squad.some((s) => s.playerId === inCandidate.playerId)) {
          continue;
        }
        const netCost = Number((inCandidate.currentPrice - sellPrice).toFixed(1));
        if (netCost > node.bank) {
          continue;
        }

        // Check max 3 players per club constraint after removing outPlayer
        const clubCount = node.squad.filter(
          (s) =>
            s.playerId !== outPlayer.playerId &&
            s.teamId === inCandidate.teamId
        ).length;
        if (clubCount >= SQUAD_RULES.MAX_PER_TEAM) {
          continue;
        }

        const move: PlannedTransferMove = {
          playerOutId: outPlayer.playerId,
          playerOutName: outPlayer.name,
          playerInId: inCandidate.playerId,
          playerInName: inCandidate.name,
          position: outPlayer.position,
          sellingPrice: sellPrice,
          purchasePrice: inCandidate.currentPrice,
          netCost,
        };

        singleTransferNodes.push(
          this.buildNextNode(node, [move], marketById, gameweekId)
        );
      }
    }

    singleTransferNodes.sort(
      (a, b) => b.cumulativeNetExpectedPoints - a.cumulativeNetExpectedPoints
    );
    const bestSingles = singleTransferNodes.slice(0, 5);
    results.push(...bestSingles);

    // Option 2: Double transfers (up to 2 transfers in the same GW)
    if (maxTransfersPerGw >= 2) {
      for (const singleNode of bestSingles.slice(0, 3)) {
        const firstMove =
          singleNode.steps[singleNode.steps.length - 1].transfersMade[0];

        for (const outPlayer of node.squad) {
          if (outPlayer.playerId === firstMove.playerOutId) continue;
          const sellPrice = TransferOptimizerEngine.calculateSellingPrice(
            outPlayer.purchasePrice,
            outPlayer.currentPrice
          );
          const candidates = topMarketByPos.get(outPlayer.position) ?? [];

          for (const inCandidate of candidates.slice(0, 3)) {
            if (
              inCandidate.playerId === firstMove.playerInId ||
              node.squad.some((s) => s.playerId === inCandidate.playerId)
            ) {
              continue;
            }

            const secondNetCost = Number(
              (inCandidate.currentPrice - sellPrice).toFixed(1)
            );
            if (firstMove.netCost + secondNetCost > node.bank) {
              continue;
            }

            const tempSquadIdsRemoved = new Set([
              firstMove.playerOutId,
              outPlayer.playerId,
            ]);
            const clubCount =
              node.squad.filter(
                (s) =>
                  !tempSquadIdsRemoved.has(s.playerId) &&
                  s.teamId === inCandidate.teamId
              ).length +
              (marketById.get(firstMove.playerInId)?.teamId ===
              inCandidate.teamId
                ? 1
                : 0);

            if (clubCount >= SQUAD_RULES.MAX_PER_TEAM) {
              continue;
            }

            const secondMove: PlannedTransferMove = {
              playerOutId: outPlayer.playerId,
              playerOutName: outPlayer.name,
              playerInId: inCandidate.playerId,
              playerInName: inCandidate.name,
              position: outPlayer.position,
              sellingPrice: sellPrice,
              purchasePrice: inCandidate.currentPrice,
              netCost: secondNetCost,
            };

            results.push(
              this.buildNextNode(
                node,
                [firstMove, secondMove],
                marketById,
                gameweekId
              )
            );
          }
        }
      }
    }

    return results;
  }

  private buildNextNode(
    parent: BeamNode,
    moves: PlannedTransferMove[],
    marketById: Map<number, MarketCandidatePlayer>,
    gameweekId: number
  ): BeamNode {
    const nextSquad = parent.squad.map((p) => {
      const move = moves.find((m) => m.playerOutId === p.playerId);
      if (!move) return { ...p };
      const replacement = marketById.get(move.playerInId)!;
      return {
        playerId: replacement.playerId,
        name: replacement.name,
        teamId: replacement.teamId,
        position: replacement.position,
        purchasePrice: replacement.currentPrice,
        currentPrice: replacement.currentPrice,
      };
    });

    const totalNetCost = moves.reduce((sum, m) => sum + m.netCost, 0);
    const nextBank = Number((parent.bank - totalNetCost).toFixed(1));

    const extraTransfers = Math.max(0, moves.length - parent.freeTransfers);
    const pointsHit = extraTransfers * Math.abs(SQUAD_RULES.TRANSFER_POINTS_COST);
    const remainingFtThisGw = Math.max(0, parent.freeTransfers - moves.length);
    const nextGwFreeTransfers = Math.min(5, remainingFtThisGw + 1);

    const lineup = TransferOptimizerEngine.selectOptimalLineupForGameweek(
      nextSquad,
      marketById,
      gameweekId
    );
    const netExpectedPoints = Number(
      (lineup.grossExpectedPoints - pointsHit).toFixed(2)
    );

    const step: GameweekTransferStep = {
      gameweekId,
      freeTransfersAvailable: parent.freeTransfers,
      transfersMade: moves,
      pointsHit,
      freeTransfersCarriedForward: remainingFtThisGw,
      remainingBank: nextBank,
      startingPlayerIds: lineup.startingPlayerIds,
      captainPlayerId: lineup.captainPlayerId,
      viceCaptainPlayerId: lineup.viceCaptainPlayerId,
      grossExpectedPoints: lineup.grossExpectedPoints,
      netExpectedPoints,
    };

    return {
      squad: nextSquad,
      bank: nextBank,
      freeTransfers: nextGwFreeTransfers,
      steps: [...parent.steps, step],
      cumulativeNetExpectedPoints: Number(
        (parent.cumulativeNetExpectedPoints + netExpectedPoints).toFixed(2)
      ),
    };
  }

  private computeCacheKey(
    squad: OptimizableSquadPlayer[],
    market: MarketCandidatePlayer[],
    options: TransferOptimizerOptions
  ): string {
    const payload = JSON.stringify({
      squad: squad.map((s) => [s.playerId, s.purchasePrice, s.currentPrice]),
      market: market.map((m) => [m.playerId, m.currentPrice, m.expectedPointsByGw]),
      options,
    });
    return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 24);
  }
}

export const transferOptimizerEngine = new TransferOptimizerEngine();
