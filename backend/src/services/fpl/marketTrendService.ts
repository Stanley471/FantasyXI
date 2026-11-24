import { prisma } from "../../config/db.js";

export interface MarketTrend {
  playerId: number;
  displayName: string;
  teamShortName: string;
  price: number;
  transfersIn: number;
  transfersOut: number;
  netTransfers: number;
  netVelocityPerHour: number;
  targetTransfers: number;
  targetProgress: number;
  direction: "RISING" | "FALLING" | "STABLE";
}

export function calculateMarketSignal(input: {
  transfersIn: number;
  transfersOut: number;
  previousNetTransfers?: number;
  elapsedHours: number;
  targetTransfers: number;
}): Pick<MarketTrend, "netTransfers" | "netVelocityPerHour" | "targetProgress" | "direction"> {
  const netTransfers = input.transfersIn - input.transfersOut;
  const previousNetTransfers = input.previousNetTransfers ?? 0;
  const velocity = (netTransfers - previousNetTransfers) / Math.max(input.elapsedHours, 1 / 60);
  const target = Math.max(1, Math.abs(input.targetTransfers));
  const targetProgress = Math.max(-100, Math.min(100, Math.round((netTransfers / target) * 100)));
  return {
    netTransfers,
    netVelocityPerHour: Math.round(velocity * 10) / 10,
    targetProgress,
    direction: targetProgress >= 10 ? "RISING" : targetProgress <= -10 ? "FALLING" : "STABLE",
  };
}

export class MarketTrendService {
  constructor(private readonly db: any = prisma) {}

  async getTrends(now = new Date(), windowHours = 6): Promise<{ rising: MarketTrend[]; falling: MarketTrend[]; generatedAt: string }> {
    const windowMs = Math.max(1, windowHours) * 60 * 60 * 1000;
    const currentStart = new Date(now.getTime() - windowMs);
    const previousStart = new Date(currentStart.getTime() - windowMs);
    const [players, totalSquads, currentIn, currentOut, previousIn, previousOut] = await Promise.all([
      this.db.player.findMany({
        select: { id: true, displayName: true, price: true, selectedByPercent: true, team: { select: { shortName: true } } },
      }),
      this.db.squad.count(),
      this.db.squadTransfer.groupBy({ by: ["playerInId"], where: { timestamp: { gte: currentStart, lte: now } }, _count: { _all: true } }),
      this.db.squadTransfer.groupBy({ by: ["playerOutId"], where: { timestamp: { gte: currentStart, lte: now } }, _count: { _all: true } }),
      this.db.squadTransfer.groupBy({ by: ["playerInId"], where: { timestamp: { gte: previousStart, lt: currentStart } }, _count: { _all: true } }),
      this.db.squadTransfer.groupBy({ by: ["playerOutId"], where: { timestamp: { gte: previousStart, lt: currentStart } }, _count: { _all: true } }),
    ]);

    const counts = (rows: any[], key: "playerInId" | "playerOutId") =>
      new Map<number, number>(rows.map((row) => [row[key], row._count._all]));
    const currentInById = counts(currentIn, "playerInId");
    const currentOutById = counts(currentOut, "playerOutId");
    const previousInById = counts(previousIn, "playerInId");
    const previousOutById = counts(previousOut, "playerOutId");

    const trends: MarketTrend[] = players.map((player: any) => {
      const ownership = Number(player.selectedByPercent ?? 0) / 100;
      const targetTransfers = Math.max(5, Math.round(Math.max(totalSquads, 100) * Math.max(ownership, 0.02) * 0.08));
      const signal = calculateMarketSignal({
        transfersIn: currentInById.get(player.id) ?? 0,
        transfersOut: currentOutById.get(player.id) ?? 0,
        previousNetTransfers: (previousInById.get(player.id) ?? 0) - (previousOutById.get(player.id) ?? 0),
        elapsedHours: windowHours,
        targetTransfers,
      });
      return {
        playerId: player.id,
        displayName: player.displayName,
        teamShortName: player.team.shortName,
        price: Number(player.price),
        transfersIn: currentInById.get(player.id) ?? 0,
        transfersOut: currentOutById.get(player.id) ?? 0,
        targetTransfers,
        ...signal,
      };
    });

    return {
      rising: trends.filter((trend) => trend.direction === "RISING").sort((a, b) => b.targetProgress - a.targetProgress).slice(0, 25),
      falling: trends.filter((trend) => trend.direction === "FALLING").sort((a, b) => a.targetProgress - b.targetProgress).slice(0, 25),
      generatedAt: now.toISOString(),
    };
  }
}

export const marketTrendService = new MarketTrendService();
