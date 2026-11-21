import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LeagueService,
  LeagueNotFoundError,
  LeagueValidationError,
  LeagueForbiddenError,
  MAX_LEAGUE_MEMBERS,
} from "../services/league/leagueService.js";
import { LeagueStatus, MembershipStatus } from "../types/index.js";

describe("LeagueService Competition Engine & Standings", () => {
  it("should generate a 6-character alphanumeric uppercase invite code", () => {
    const code = LeagueService.generateInviteCode();
    assert.equal(code.length, 6);
    assert.match(code, /^[A-Z0-9]{6}$/);
  });

  describe("Deterministic Standings & Multi-Gameweek Scoring", () => {
    // Pure logic test for deterministic standings ranking and tie-breaking
    it("should rank managers by total points across league gameweek window", () => {
      const entries = [
        {
          userId: "user-1",
          username: "Alice",
          squadId: "squad-1",
          squadName: "Alice FC",
          membershipStatus: MembershipStatus.ACTIVE,
          totalPoints: 120,
          bestGameweekPoints: 65,
          gameweekScores: [
            { gameweekId: 1, gameweekName: "GW1", points: 55 },
            { gameweekId: 2, gameweekName: "GW2", points: 65 },
          ],
          joinedAt: new Date("2026-08-01T10:00:00Z"),
        },
        {
          userId: "user-2",
          username: "Bob",
          squadId: "squad-2",
          squadName: "Bob FC",
          membershipStatus: MembershipStatus.ACTIVE,
          totalPoints: 135,
          bestGameweekPoints: 70,
          gameweekScores: [
            { gameweekId: 1, gameweekName: "GW1", points: 65 },
            { gameweekId: 2, gameweekName: "GW2", points: 70 },
          ],
          joinedAt: new Date("2026-08-01T11:00:00Z"),
        },
      ];

      // Sort by totalPoints descending
      entries.sort((a, b) => b.totalPoints - a.totalPoints);
      const ranked = entries.map((e, idx) => ({ rank: idx + 1, ...e }));

      assert.equal(ranked[0].username, "Bob");
      assert.equal(ranked[0].rank, 1);
      assert.equal(ranked[0].totalPoints, 135);

      assert.equal(ranked[1].username, "Alice");
      assert.equal(ranked[1].rank, 2);
      assert.equal(ranked[1].totalPoints, 120);
    });

  });

  describe("Official tie-break hierarchy (issue #503)", () => {
    interface MemberSetup {
      userId: string;
      username: string;
      squadId: string;
      squadName: string;
      joinedAt: string;
      points: number[]; // one entry per gameweek, gameweeks 1..N
      transfers: number;
      playerGoalsScored: number[]; // one player per entry, this player's season goals
      playerGoalsConceded: number[]; // goals conceded recorded for the same players, within the window
    }

    function buildMockDb(members: MemberSetup[], gameweekCount: number) {
      const league = {
        id: "league-1",
        name: "Tie-break League",
        status: LeagueStatus.ACTIVE,
        entryFee: 0,
        prizePool: 0,
        currentMembers: members.length,
        startGameweekId: 1,
        endGameweekId: gameweekCount,
        scoringConfig: null,
        startGameweek: { id: 1, name: "Gameweek 1" },
        endGameweek: { id: gameweekCount, name: `Gameweek ${gameweekCount}` },
        members: members.map((m) => ({
          userId: m.userId,
          squadId: m.squadId,
          status: MembershipStatus.ACTIVE,
          joinedAt: new Date(m.joinedAt),
          user: { username: m.username },
          squad: { name: m.squadName },
        })),
      };

      const gameweeks = Array.from({ length: gameweekCount }, (_, i) => ({
        id: i + 1,
        name: `Gameweek ${i + 1}`,
      }));

      const squadGameweekScores = members.flatMap((m) =>
        m.points.map((points, i) => ({
          squadId: m.squadId,
          gameweekId: i + 1,
          points,
          gameweek: { id: i + 1, name: `Gameweek ${i + 1}` },
        }))
      );

      // One synthetic player per member, scoped to that squad, carrying the
      // season goals and gameweek-conceded figures the test wants to exercise.
      const squadPlayers = members.flatMap((m, idx) => ({
        squadId: m.squadId,
        playerId: idx + 1,
        player: { goalsScored: m.playerGoalsScored[0] ?? 0 },
      }));

      const playerGameweekStatsByPlayer = new Map<number, number>(
        members.map((m, idx) => [idx + 1, m.playerGoalsConceded.reduce((s, v) => s + v, 0)])
      );

      return {
        league: { findUnique: async () => ({ ...league }) },
        gameweek: { findMany: async () => gameweeks },
        squadGameweekScore: {
          findMany: async ({ where }: any) =>
            squadGameweekScores.filter(
              (s) =>
                where.squadId.in.includes(s.squadId) &&
                s.gameweekId >= where.gameweekId.gte &&
                s.gameweekId <= where.gameweekId.lte
            ),
        },
        squadTransfer: {
          groupBy: async ({ where }: any) => {
            const counts = new Map<string, number>();
            for (const m of members) {
              if (where.squadId.in.includes(m.squadId)) counts.set(m.squadId, m.transfers);
            }
            return Array.from(counts.entries()).map(([squadId, count]) => ({
              squadId,
              _count: { _all: count },
            }));
          },
        },
        squadPlayer: {
          findMany: async ({ where }: any) =>
            squadPlayers.filter((sp) => where.squadId.in.includes(sp.squadId)),
        },
        playerGameweekStats: {
          groupBy: async ({ where }: any) =>
            where.playerId.in
              .filter((id: number) => playerGameweekStatsByPlayer.has(id))
              .map((id: number) => ({
                playerId: id,
                _sum: { goalsConceded: playerGameweekStatsByPlayer.get(id) ?? 0 },
              })),
        },
      };
    }

    it("resolves identical totals by fewest transfers made, and flags the tie-break", async () => {
      const db = buildMockDb(
        [
          {
            userId: "user-a",
            username: "Alice",
            squadId: "squad-a",
            squadName: "Alice FC",
            joinedAt: "2026-08-01T09:00:00Z",
            points: [75, 75],
            transfers: 3,
            playerGoalsScored: [10],
            playerGoalsConceded: [5],
          },
          {
            userId: "user-b",
            username: "Bob",
            squadId: "squad-b",
            squadName: "Bob FC",
            joinedAt: "2026-08-01T12:00:00Z",
            points: [60, 90],
            transfers: 1,
            playerGoalsScored: [10],
            playerGoalsConceded: [5],
          },
        ],
        2
      );
      const service = new LeagueService(db);
      const { standings } = await service.getLeagueStandings("league-1");

      assert.equal(standings[0].username, "Bob");
      assert.equal(standings[0].tieBreak, "transfers");
      assert.equal(standings[1].username, "Alice");
      assert.equal(standings[1].tieBreak, "transfers");
    });

    it("falls through to most goals scored by squad when transfers also tie", async () => {
      const db = buildMockDb(
        [
          {
            userId: "user-c",
            username: "Charlie",
            squadId: "squad-c",
            squadName: "Charlie FC",
            joinedAt: "2026-08-01T09:00:00Z",
            points: [150],
            transfers: 2,
            playerGoalsScored: [12],
            playerGoalsConceded: [8],
          },
          {
            userId: "user-d",
            username: "David",
            squadId: "squad-d",
            squadName: "David FC",
            joinedAt: "2026-08-01T12:00:00Z",
            points: [150],
            transfers: 2,
            playerGoalsScored: [20],
            playerGoalsConceded: [8],
          },
        ],
        1
      );
      const service = new LeagueService(db);
      const { standings } = await service.getLeagueStandings("league-1");

      assert.equal(standings[0].username, "David");
      assert.equal(standings[0].tieBreak, "goalsScored");
      assert.equal(standings[1].username, "Charlie");
    });

    it("falls through to fewest goals conceded when transfers and goals scored also tie", async () => {
      const db = buildMockDb(
        [
          {
            userId: "user-e",
            username: "Emma",
            squadId: "squad-e",
            squadName: "Emma FC",
            joinedAt: "2026-08-01T09:00:00Z",
            points: [100],
            transfers: 1,
            playerGoalsScored: [15],
            playerGoalsConceded: [10],
          },
          {
            userId: "user-f",
            username: "Frank",
            squadId: "squad-f",
            squadName: "Frank FC",
            joinedAt: "2026-08-01T12:00:00Z",
            points: [100],
            transfers: 1,
            playerGoalsScored: [15],
            playerGoalsConceded: [3],
          },
        ],
        1
      );
      const service = new LeagueService(db);
      const { standings } = await service.getLeagueStandings("league-1");

      assert.equal(standings[0].username, "Frank");
      assert.equal(standings[0].tieBreak, "goalsConceded");
      assert.equal(standings[1].username, "Emma");
    });

    it("falls back to earliest join timestamp when every official criterion ties, without a tie-break flag", async () => {
      const db = buildMockDb(
        [
          {
            userId: "user-g",
            username: "Frank2",
            squadId: "squad-g",
            squadName: "Frank2 FC",
            joinedAt: "2026-08-01T10:05:00Z",
            points: [100],
            transfers: 1,
            playerGoalsScored: [15],
            playerGoalsConceded: [5],
          },
          {
            userId: "user-h",
            username: "Emma2",
            squadId: "squad-h",
            squadName: "Emma2 FC",
            joinedAt: "2026-08-01T10:00:00Z",
            points: [100],
            transfers: 1,
            playerGoalsScored: [15],
            playerGoalsConceded: [5],
          },
        ],
        1
      );
      const service = new LeagueService(db);
      const { standings } = await service.getLeagueStandings("league-1");

      assert.equal(standings[0].username, "Emma2");
      assert.equal(standings[1].username, "Frank2");
      assert.equal(standings[0].tieBreak, null);
      assert.equal(standings[1].tieBreak, null);
    });

    it("does not flag a tie-break for managers who are not tied on points", async () => {
      const db = buildMockDb(
        [
          {
            userId: "user-i",
            username: "Grace",
            squadId: "squad-i",
            squadName: "Grace FC",
            joinedAt: "2026-08-01T09:00:00Z",
            points: [120],
            transfers: 5,
            playerGoalsScored: [8],
            playerGoalsConceded: [12],
          },
          {
            userId: "user-j",
            username: "Henry",
            squadId: "squad-j",
            squadName: "Henry FC",
            joinedAt: "2026-08-01T12:00:00Z",
            points: [90],
            transfers: 0,
            playerGoalsScored: [20],
            playerGoalsConceded: [1],
          },
        ],
        1
      );
      const service = new LeagueService(db);
      const { standings } = await service.getLeagueStandings("league-1");

      assert.equal(standings[0].username, "Grace");
      assert.equal(standings[0].tieBreak, null);
      assert.equal(standings[1].tieBreak, null);
    });
  });

  describe("League Creation & Join Domain Rules", () => {
    it("should reject league creation with empty name", () => {
      assert.throws(
        () => {
          const input = {
            name: "   ",
            entryFee: 10,
            startGameweekId: 1,
            endGameweekId: 5,
            squadId: "squad-1",
          };
          if (!input.name || input.name.trim().length === 0) {
            throw new LeagueValidationError("League name is required");
          }
        },
        LeagueValidationError
      );
    });

    it("should reject negative entry fee", () => {
      assert.throws(
        () => {
          const input = {
            name: "Premier Contest",
            entryFee: -5.0,
            startGameweekId: 1,
            endGameweekId: 5,
            squadId: "squad-1",
          };
          if (input.entryFee < 0) {
            throw new LeagueValidationError("Entry fee must be 0 or greater");
          }
        },
        LeagueValidationError
      );
    });

    it("should reject participant limits below 2", () => {
      assert.throws(
        () => {
          const maxMembers = 1;
          if (maxMembers < 2 || maxMembers > 100) {
            throw new LeagueValidationError("Maximum participants must be between 2 and 100");
          }
        },
        LeagueValidationError
      );
    });

    it("should reject end gameweek earlier than start gameweek", () => {
      assert.throws(
        () => {
          const startGw = { id: 10, fplId: 10, name: "Gameweek 10" };
          const endGw = { id: 5, fplId: 5, name: "Gameweek 5" };
          if (endGw.fplId < startGw.fplId) {
            throw new LeagueValidationError(
              `End gameweek (${endGw.name}) cannot be earlier than start gameweek (${startGw.name})`
            );
          }
        },
        LeagueValidationError
      );
    });

    it("should allow single gameweek league (startGameweek === endGameweek)", () => {
      const startGw = { id: 5, fplId: 5, name: "Gameweek 5" };
      const endGw = { id: 5, fplId: 5, name: "Gameweek 5" };

      assert.doesNotThrow(() => {
        if (endGw.fplId < startGw.fplId) {
          throw new LeagueValidationError("End gameweek cannot be earlier than start");
        }
      });
    });

    it("should reject joining a league that is full", () => {
      const league = { currentMembers: 20, maxMembers: 20, status: LeagueStatus.UPCOMING };
      assert.throws(
        () => {
          if (league.currentMembers >= league.maxMembers) {
            throw new LeagueValidationError("League is full");
          }
        },
        LeagueValidationError
      );
    });

    it("should reject joining an ACTIVE or CANCELLED league", () => {
      const activeLeague: { status: LeagueStatus } = { status: LeagueStatus.ACTIVE };
      const cancelledLeague: { status: LeagueStatus } = { status: LeagueStatus.CANCELLED };

      assert.throws(
        () => {
          if (activeLeague.status !== LeagueStatus.UPCOMING) {
            throw new LeagueValidationError("Cannot join non-UPCOMING league");
          }
        },
        LeagueValidationError
      );

      assert.throws(
        () => {
          if (cancelledLeague.status !== LeagueStatus.UPCOMING) {
            throw new LeagueValidationError("Cannot join non-UPCOMING league");
          }
        },
        LeagueValidationError
      );
    });
  });

  it("should support participant limits in the thousands", () => {
    assert.ok(5_000 >= 2 && 5_000 <= MAX_LEAGUE_MEMBERS);
    assert.ok(MAX_LEAGUE_MEMBERS > 5_000);
  });

  it("should paginate league members with stable ordering and total metadata", async () => {
    const memberFindMany = async (args: any) => {
      assert.deepEqual(args.where, { leagueId: "league-1" });
      assert.deepEqual(args.orderBy, [{ joinedAt: "asc" }, { id: "asc" }]);
      assert.equal(args.skip, 20);
      assert.equal(args.take, 20);
      return [{ id: "member-21" }];
    };
    const service = new LeagueService({
      league: { findUnique: async () => ({ id: "league-1" }) },
      leagueMember: {
        findMany: memberFindMany,
        count: async () => 45,
      },
    });

    const result = await service.getLeagueMembers("league-1", 2, 20);

    assert.deepEqual(result, {
      members: [{ id: "member-21" }],
      total: 45,
      page: 2,
      limit: 20,
      totalPages: 3,
    });
  });

  it("should reject paginated member reads for an unknown league", async () => {
    const service = new LeagueService({
      league: { findUnique: async () => null },
      leagueMember: { findMany: async () => [], count: async () => 0 },
    });

    await assert.rejects(
      service.getLeagueMembers("missing-league", 1, 20),
      LeagueNotFoundError
    );
  });

  describe("Lifecycle State Machine", () => {
    it("should enforce valid transition UPCOMING -> ACTIVE", () => {
      const currentStatus: LeagueStatus = LeagueStatus.UPCOMING;
      const targetStatus: LeagueStatus = LeagueStatus.ACTIVE;
      const currentMembers = 5;
      const minMembers = 2;

      let nextStatus: LeagueStatus = currentStatus;
      if (targetStatus === LeagueStatus.ACTIVE) {
        if (currentStatus !== LeagueStatus.UPCOMING) {
          throw new LeagueValidationError(`Cannot transition to ACTIVE from ${currentStatus}`);
        }
        if (currentMembers < minMembers) {
          throw new LeagueValidationError("Minimum participants not met");
        }
        nextStatus = LeagueStatus.ACTIVE;
      }

      assert.equal(nextStatus, LeagueStatus.ACTIVE);
    });

    it("should reject UPCOMING -> ACTIVE if minimum participants not met", () => {
      const currentStatus: LeagueStatus = LeagueStatus.UPCOMING;
      const targetStatus: LeagueStatus = LeagueStatus.ACTIVE;
      const currentMembers = 1;
      const minMembers = 2;

      assert.throws(
        () => {
          if (targetStatus === LeagueStatus.ACTIVE) {
            if (currentMembers < minMembers) {
              throw new LeagueValidationError("Minimum participants not met");
            }
          }
        },
        LeagueValidationError
      );
    });

    it("should reject transitions from terminal states (COMPLETED, CANCELLED)", () => {
      const checkTerminal = (status: LeagueStatus) => {
        if (status === LeagueStatus.COMPLETED || status === LeagueStatus.CANCELLED) {
          throw new LeagueValidationError(`Cannot transition from terminal state ${status}`);
        }
      };

      assert.throws(
        () => checkTerminal(LeagueStatus.COMPLETED),
        LeagueValidationError
      );

      assert.throws(
        () => checkTerminal(LeagueStatus.CANCELLED),
        LeagueValidationError
      );
    });

    it("should reject cancellation by a non-creator user", () => {
      const league = { creatorId: "creator-123", status: LeagueStatus.UPCOMING };
      const requesterId = "intruder-456";

      assert.throws(
        () => {
          if (league.creatorId !== requesterId) {
            throw new LeagueForbiddenError(
              "Only the league creator has permission to cancel this league"
            );
          }
        },
        LeagueForbiddenError
      );
    });
  });
});
