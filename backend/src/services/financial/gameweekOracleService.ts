import { createHash } from "node:crypto";
import { prisma } from "../../config/db.js";
import { SorobanContractClient } from "./sorobanContractClient.js";

export interface GameweekOracleScore {
  squadId: string;
  points: number;
}

export function createGameweekResultProof(
  gameweekId: number,
  scores: GameweekOracleScore[]
): string {
  const orderedScores = [...scores]
    .sort((a, b) => a.squadId.localeCompare(b.squadId))
    .map(({ squadId, points }) => ({ squadId, points }));
  return createHash("sha256")
    .update(JSON.stringify({ gameweekId, scores: orderedScores }), "utf8")
    .digest("hex");
}

export class GameweekOracleService {
  constructor(
    private readonly db: any = prisma,
    private readonly clientFactory: () => SorobanContractClient = () => new SorobanContractClient()
  ) {}

  public async publishFinalGameweek(
    gameweekId: number,
    adminKey: string
  ) {
    const gameweek = await this.db.gameweek.findUnique({
      where: { id: gameweekId },
      include: { fixtures: { select: { finished: true } } },
    });
    if (!gameweek) throw new Error(`Gameweek ${gameweekId} not found`);
    if (gameweek.fixtures.length === 0 || gameweek.fixtures.some((fixture: any) => !fixture.finished)) {
      throw new Error("Only gameweeks with all fixtures finished can be published to Soroban");
    }

    const scores: GameweekOracleScore[] = await this.db.squadGameweekScore.findMany({
      where: { gameweekId },
      select: { squadId: true, points: true },
    });
    if (scores.length === 0 || scores.some((score) => !Number.isFinite(score.points))) {
      throw new Error("Final gameweek scores are missing or invalid");
    }

    const proofHash = createGameweekResultProof(gameweek.fplId, scores);
    return this.clientFactory().publishGameweekResult(
      adminKey,
      gameweek.fplId,
      proofHash
    );
  }
}

export const gameweekOracleService = new GameweekOracleService();