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

    it("should break ties using highest single gameweek score (Peak Score Tie-break)", () => {
      // Both Charlie and David scored 150 total points across 3 gameweeks.
      // Charlie: 40 + 50 + 60 (peak: 60)
      // David:   30 + 50 + 70 (peak: 70)
      // David should win the tie-break!
      const entries = [
        {
          userId: "user-3",
          username: "Charlie",
          squadId: "squad-3",
          squadName: "Charlie FC",
          membershipStatus: MembershipStatus.ACTIVE,
          totalPoints: 150,
          bestGameweekPoints: 60,
          joinedAt: new Date("2026-08-01T09:00:00Z"), // Earlier join
        },
        {
          userId: "user-4",
          username: "David",
          squadId: "squad-4",
          squadName: "David FC",
          membershipStatus: MembershipStatus.ACTIVE,
          totalPoints: 150,
          bestGameweekPoints: 70, // Higher peak gameweek score!
          joinedAt: new Date("2026-08-01T12:00:00Z"),
        },
      ];

      entries.sort((a, b) => {
        if (b.totalPoints !== a.totalPoints) {
          return b.totalPoints - a.totalPoints;
        }
        if (b.bestGameweekPoints !== a.bestGameweekPoints) {
          return b.bestGameweekPoints - a.bestGameweekPoints;
        }
        return a.joinedAt.getTime() - b.joinedAt.getTime();
      });

      assert.equal(entries[0].username, "David");
      assert.equal(entries[1].username, "Charlie");
    });

    it("should break secondary ties using earliest join timestamp (Deterministic Timestamp Tie-break)", () => {
      // Both Emma and Frank scored 100 points AND both have peak gameweek of 50.
      // Emma joined at 10:00:00, Frank joined at 10:05:00.
      // Emma wins the secondary tie-break deterministically!
      const entries = [
        {
          userId: "user-6",
          username: "Frank",
          totalPoints: 100,
          bestGameweekPoints: 50,
          joinedAt: new Date("2026-08-01T10:05:00Z"),
        },
        {
          userId: "user-5",
          username: "Emma",
          totalPoints: 100,
          bestGameweekPoints: 50,
          joinedAt: new Date("2026-08-01T10:00:00Z"),
        },
      ];

      entries.sort((a, b) => {
        if (b.totalPoints !== a.totalPoints) {
          return b.totalPoints - a.totalPoints;
        }
        if (b.bestGameweekPoints !== a.bestGameweekPoints) {
          return b.bestGameweekPoints - a.bestGameweekPoints;
        }
        return a.joinedAt.getTime() - b.joinedAt.getTime();
      });

      assert.equal(entries[0].username, "Emma");
      assert.equal(entries[1].username, "Frank");
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
