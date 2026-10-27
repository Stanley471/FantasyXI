import { prisma } from "../../config/db.js";

const INITIAL_RATING = 1200;
const PROVISIONAL_GAMES = 10;

export class MatchmakingQueueError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "MatchmakingQueueError";
  }
}

function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateEloDelta(
  rating: number,
  opponentRating: number,
  score: number,
  margin: number,
  gamesPlayed: number,
  opponentGamesPlayed: number
): number {
  const kFactor = gamesPlayed < PROVISIONAL_GAMES || opponentGamesPlayed < PROVISIONAL_GAMES ? 40 : 24;
  const marginFactor = clamp(Math.log1p(Math.abs(margin)) / Math.log(10), 1, 2);
  const scheduleFactor = clamp(1 + ((rating + opponentRating) / 2 - INITIAL_RATING) / 4000, 0.75, 1.25);
  return kFactor * marginFactor * scheduleFactor * (score - expectedScore(rating, opponentRating));
}

export function areRatingsCompatible(rating: number, opponentRating: number, tolerance: number, opponentTolerance: number): boolean {
  return Math.abs(rating - opponentRating) <= Math.min(tolerance, opponentTolerance);
}

/** Apply one idempotent, deterministic rating update after official H2H settlement. */
export async function updateMatchRatings(gameweekId: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const alreadyUpdated = await tx.matchRatingHistory.count({ where: { gameweekId } });
    if (alreadyUpdated > 0) return 0;

    const fixtures = await tx.leagueFixture.findMany({
      where: {
        gameweekId,
        isFinished: true,
        awayMemberId: { not: null },
        homeScore: { not: null },
        awayScore: { not: null },
        league: { scoringType: "HEAD_TO_HEAD" },
      },
      orderBy: { id: "asc" },
      include: {
        homeMember: { select: { userId: true } },
        awayMember: { select: { userId: true } },
      },
    });
    if (fixtures.length === 0) return 0;

    const userIds = [...new Set(fixtures.flatMap((fixture) => [fixture.homeMember.userId, fixture.awayMember!.userId]))];
    const existing = await tx.matchRating.findMany({ where: { userId: { in: userIds } } });
    const current = new Map(existing.map((rating) => [rating.userId, rating]));
    const deltas = new Map(userIds.map((id) => [id, 0]));
    const games = new Map(userIds.map((id) => [id, 0]));

    for (const fixture of fixtures) {
      const homeId = fixture.homeMember.userId;
      const awayId = fixture.awayMember!.userId;
      if (homeId === awayId || fixture.homeScore === null || fixture.awayScore === null) continue;
      const homeRating = current.get(homeId)?.rating ?? INITIAL_RATING;
      const awayRating = current.get(awayId)?.rating ?? INITIAL_RATING;
      const outcome = fixture.homeScore > fixture.awayScore ? 1 : fixture.homeScore < fixture.awayScore ? 0 : 0.5;
      const margin = fixture.homeScore - fixture.awayScore;
      deltas.set(homeId, (deltas.get(homeId) ?? 0) + calculateEloDelta(
        homeRating,
        awayRating,
        outcome,
        margin,
        current.get(homeId)?.gamesPlayed ?? 0,
        current.get(awayId)?.gamesPlayed ?? 0
      ));
      deltas.set(awayId, (deltas.get(awayId) ?? 0) + calculateEloDelta(
        awayRating,
        homeRating,
        1 - outcome,
        margin,
        current.get(awayId)?.gamesPlayed ?? 0,
        current.get(homeId)?.gamesPlayed ?? 0
      ));
      games.set(homeId, (games.get(homeId) ?? 0) + 1);
      games.set(awayId, (games.get(awayId) ?? 0) + 1);
    }

    for (const userId of userIds) {
      const previous = current.get(userId);
      const ratingBefore = previous?.rating ?? INITIAL_RATING;
      const delta = deltas.get(userId) ?? 0;
      const ratingAfter = Number((ratingBefore + delta).toFixed(2));
      const gamesPlayed = (previous?.gamesPlayed ?? 0) + (games.get(userId) ?? 0);
      const volatility = Number(Math.sqrt(0.9 * (previous?.volatility ?? 0) ** 2 + 0.1 * delta ** 2).toFixed(2));
      await tx.matchRating.upsert({
        where: { userId },
        create: { userId, rating: ratingAfter, gamesPlayed, volatility },
        update: { rating: ratingAfter, gamesPlayed, volatility },
      });
      await tx.matchRatingHistory.create({
        data: { userId, gameweekId, ratingBefore, ratingAfter, delta: Number(delta.toFixed(2)) },
      });
    }
    return userIds.length;
  }, { isolationLevel: "Serializable" });
}

/** Find active platform users whose rating is within the requested band. */
export async function findMatchmakingCandidates(userId: string, requestedTolerance = 200) {
  const tolerance = clamp(Math.trunc(requestedTolerance), 100, 1000);
  const own = await prisma.matchRating.findUnique({ where: { userId } });
  const ownRating = own?.rating ?? INITIAL_RATING;
  const users = await prisma.user.findMany({
    where: { id: { not: userId }, squads: { some: {} } },
    select: { id: true, username: true, matchRating: { select: { rating: true, gamesPlayed: true } } },
  });
  return users
    .map((user) => ({
      userId: user.id,
      username: user.username,
      rating: user.matchRating?.rating ?? INITIAL_RATING,
      provisional: (user.matchRating?.gamesPlayed ?? 0) < PROVISIONAL_GAMES,
    }))
    .filter((candidate) => Math.abs(candidate.rating - ownRating) <= tolerance)
    .sort((a, b) => Math.abs(a.rating - ownRating) - Math.abs(b.rating - ownRating) || a.userId.localeCompare(b.userId))
    .slice(0, 20);
}

/** Queue a player and atomically pair the oldest compatible waiting opponent. */
export async function joinMatchmakingQueue(userId: string, requestedTolerance = 200) {
  const tolerance = clamp(Math.trunc(requestedTolerance), 100, 1000);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, squads: { select: { id: true }, take: 1 } } });
    if (!user || user.squads.length === 0) throw new MatchmakingQueueError("Create a squad before joining matchmaking", 400);

    const rating = await tx.matchRating.findUnique({ where: { userId } });
    const ratingAtRequest = rating?.rating ?? INITIAL_RATING;
    const existing = await tx.matchmakingQueueEntry.findUnique({
      where: { userId },
      include: { matchedUser: { select: { id: true, username: true } } },
    });
    if (existing?.status === "MATCHED") {
      return {
        status: "MATCHED" as const,
        rating: existing.ratingAtRequest,
        opponent: existing.matchedUser,
        matchedAt: existing.matchedAt,
      };
    }
    const queueEntry = existing
      ? await tx.matchmakingQueueEntry.update({ where: { id: existing.id }, data: { ratingAtRequest, tolerance } })
      : await tx.matchmakingQueueEntry.create({ data: { userId, ratingAtRequest, tolerance } });
    const candidates = await tx.matchmakingQueueEntry.findMany({
      where: {
        status: "QUEUED",
        userId: { not: userId },
        ratingAtRequest: { gte: ratingAtRequest - tolerance, lte: ratingAtRequest + tolerance },
      },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      include: { user: { select: { id: true, username: true } } },
    });
    const opponent = candidates.find((candidate) =>
      areRatingsCompatible(ratingAtRequest, candidate.ratingAtRequest, tolerance, candidate.tolerance)
    );
    if (!opponent) {
      return { status: "QUEUED" as const, rating: ratingAtRequest, opponent: null, joinedAt: queueEntry.joinedAt };
    }

    const matchedAt = new Date();
    const ownClaim = await tx.matchmakingQueueEntry.updateMany({
      where: { id: queueEntry.id, status: "QUEUED" },
      data: { status: "MATCHED", matchedUserId: opponent.userId, matchedAt, tolerance, ratingAtRequest },
    });
    const opponentClaim = await tx.matchmakingQueueEntry.updateMany({
      where: { id: opponent.id, status: "QUEUED" },
      data: { status: "MATCHED", matchedUserId: userId, matchedAt },
    });
    if (ownClaim.count !== 1 || opponentClaim.count !== 1) {
      throw new MatchmakingQueueError("Matchmaking queue changed while pairing; retry the request", 409);
    }
    return {
      status: "MATCHED" as const,
      rating: ratingAtRequest,
      opponent: { id: opponent.user.id, username: opponent.user.username, rating: opponent.ratingAtRequest },
      matchedAt,
    };
  }, { isolationLevel: "Serializable" });
}
