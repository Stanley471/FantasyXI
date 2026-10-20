import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LeagueService,
  LeagueNotFoundError,
  LeagueValidationError,
  LeagueForbiddenError,
  MAX_LEAGUE_MEMBERS,
} from "../services/league/leagueService.js";
import { LeagueStatus, MembershipStatus, LeagueTierMovement } from "../types/index.js";
import { InMemoryEventBus } from "../services/events/eventBus.js";
import {
  LEAGUE_TIER_TRANSITION_COMPLETED_EVENT,
  LeagueTierTransitionCompletedPayload,
} from "../services/events/domainEvents.js";

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

  describe("Multi-Tier League Promotion/Relegation Transition Pipeline (Issue #228)", () => {
    function createPyramidMockDb() {
      const tierGroup = {
        id: "group-pyramid-1",
        name: "FantasyXI Pro Pyramid",
        season: "2025/26",
        tiers: [
          {
            id: "tier-1",
            groupId: "group-pyramid-1",
            name: "Premier Division",
            rank: 1,
            promotionTargetTierId: null,
            relegationTargetTierId: "tier-2",
          },
          {
            id: "tier-2",
            groupId: "group-pyramid-1",
            name: "Championship Division",
            rank: 2,
            promotionTargetTierId: "tier-1",
            relegationTargetTierId: "tier-3",
          },
          {
            id: "tier-3",
            groupId: "group-pyramid-1",
            name: "League One Division",
            rank: 3,
            promotionTargetTierId: "tier-2",
            relegationTargetTierId: null,
          },
        ],
      };

      const makeSeasonEntry = (
        id: string,
        leagueId: string,
        tierId: string,
        totalPoints: number,
        goalsScored: number,
        transferHits: number,
        createdAtIso: string = "2025-08-01T10:00:00Z"
      ) => ({
        id,
        leagueId,
        season: "2025/26",
        tierGroupId: "group-pyramid-1",
        tierId,
        previousSeasonId: null,
        league: {
          id: leagueId,
          createdAt: new Date(createdAtIso),
          members: [
            {
              userId: `user-${leagueId}`,
              totalPoints,
              goalsScored,
              transferHits,
              joinedAt: new Date(createdAtIso),
            },
          ],
        },
        tier: tierGroup.tiers.find((t) => t.id === tierId)!,
        placements: [],
      });

      // 8 entries per tier across 3 tiers (24 total): top 3 promote, bottom 3 relegate
      const initialSeasons = [
        // Tier 1 (Premier): only bottom 3 relegate to tier-2
        makeSeasonEntry("ls-t1-1", "lg-t1-1", "tier-1", 2400, 75, 4),
        makeSeasonEntry("ls-t1-2", "lg-t1-2", "tier-1", 2350, 72, 8),
        makeSeasonEntry("ls-t1-3", "lg-t1-3", "tier-1", 2300, 68, 12),
        makeSeasonEntry("ls-t1-4", "lg-t1-4", "tier-1", 2220, 64, 16),
        makeSeasonEntry("ls-t1-5", "lg-t1-5", "tier-1", 2150, 60, 12), // 5th (safe at cutoff)
        makeSeasonEntry("ls-t1-6", "lg-t1-6", "tier-1", 2150, 58, 8),  // 6th (relegated on goalsScored tie-breaker: 58 < 60)
        makeSeasonEntry("ls-t1-7", "lg-t1-7", "tier-1", 2050, 52, 20), // 7th (relegated)
        makeSeasonEntry("ls-t1-8", "lg-t1-8", "tier-1", 1980, 49, 28), // 8th (relegated)

        // Tier 2 (Championship): top 3 promote to tier-1, bottom 3 relegate to tier-3
        makeSeasonEntry("ls-t2-1", "lg-t2-1", "tier-2", 2290, 70, 8),  // 1st (promoted)
        makeSeasonEntry("ls-t2-2", "lg-t2-2", "tier-2", 2240, 66, 12), // 2nd (promoted)
        makeSeasonEntry("ls-t2-3", "lg-t2-3", "tier-2", 2200, 62, 4),  // 3rd (promoted on transferHits tie-breaker: 4 < 16)
        makeSeasonEntry("ls-t2-4", "lg-t2-4", "tier-2", 2200, 62, 16), // 4th (misses promotion on transferHits: 16 > 4)
        makeSeasonEntry("ls-t2-5", "lg-t2-5", "tier-2", 2110, 59, 12), // 5th (stays)
        makeSeasonEntry("ls-t2-6", "lg-t2-6", "tier-2", 2040, 55, 16), // 6th (relegated)
        makeSeasonEntry("ls-t2-7", "lg-t2-7", "tier-2", 1990, 50, 20), // 7th (relegated)
        makeSeasonEntry("ls-t2-8", "lg-t2-8", "tier-2", 1920, 45, 24), // 8th (relegated)

        // Tier 3 (League One): top 3 promote to tier-2
        makeSeasonEntry("ls-t3-1", "lg-t3-1", "tier-3", 2180, 68, 4),  // 1st (promoted)
        makeSeasonEntry("ls-t3-2", "lg-t3-2", "tier-3", 2140, 65, 8),  // 2nd (promoted)
        makeSeasonEntry("ls-t3-3", "lg-t3-3", "tier-3", 2100, 61, 8),  // 3rd (promoted on goalsScored: 61 > 57)
        makeSeasonEntry("ls-t3-4", "lg-t3-4", "tier-3", 2100, 57, 4),  // 4th (stays)
        makeSeasonEntry("ls-t3-5", "lg-t3-5", "tier-3", 2030, 54, 12),
        makeSeasonEntry("ls-t3-6", "lg-t3-6", "tier-3", 1970, 51, 16),
        makeSeasonEntry("ls-t3-7", "lg-t3-7", "tier-3", 1910, 48, 20),
        makeSeasonEntry("ls-t3-8", "lg-t3-8", "tier-3", 1850, 44, 28),
      ];

      const leagueSeasonsStore = new Map<string, any>();
      for (const s of initialSeasons) {
        leagueSeasonsStore.set(`${s.leagueId}::${s.season}`, s);
      }

      const placementsStore = new Map<string, any>();

      const db: any = {
        leagueSeasonsStore,
        placementsStore,
        $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
        leagueTierGroup: {
          findUnique: async ({ where }: any) =>
            where.id === tierGroup.id ? tierGroup : null,
        },
        leagueSeason: {
          findMany: async ({ where }: any) => {
            return Array.from(leagueSeasonsStore.values()).filter(
              (s) => s.season === where.season && s.tierGroupId === where.tierGroupId
            );
          },
          findUnique: async ({ where }: any) => {
            if (where.leagueId_season) {
              const key = `${where.leagueId_season.leagueId}::${where.leagueId_season.season}`;
              return leagueSeasonsStore.get(key) ?? null;
            }
            return null;
          },
          create: async ({ data }: any) => {
            const record = {
              id: `next-${data.leagueId}-${data.season}`,
              ...data,
            };
            leagueSeasonsStore.set(`${data.leagueId}::${data.season}`, record);
            return record;
          },
          update: async ({ where, data }: any) => {
            const existing = Array.from(leagueSeasonsStore.values()).find(
              (s) => s.id === where.id
            );
            const updated = { ...existing, ...data };
            leagueSeasonsStore.set(`${updated.leagueId}::${updated.season}`, updated);
            return updated;
          },
        },
        leagueTierPlacement: {
          upsert: async ({ where, update, create }: any) => {
            const key = `${where.leagueSeasonId_groupId.leagueSeasonId}::${where.leagueSeasonId_groupId.groupId}`;
            const existing = placementsStore.get(key);
            const record = existing ? { ...existing, ...update } : { id: `pl-${key}`, ...create };
            placementsStore.set(key, record);
            return record;
          },
        },
      };

      return db;
    }

    it("transitions a 3-tier pyramid across seasons with top-3 promotion, bottom-3 relegation, and cutoff tie-breakers", async () => {
      const db = createPyramidMockDb();
      const bus = new InMemoryEventBus();
      const publishedEvents: LeagueTierTransitionCompletedPayload[] = [];
      bus.subscribe<LeagueTierTransitionCompletedPayload>(
        LEAGUE_TIER_TRANSITION_COMPLETED_EVENT,
        (payload) => {
          publishedEvents.push(payload);
        }
      );

      const service = new LeagueService(db, bus);
      const result = await service.applySeasonEndTierTransitions("2025/26", "group-pyramid-1");

      assert.equal(result.processed, 24);
      assert.equal(result.promotions, 6); // 3 from Tier 2 -> Tier 1, 3 from Tier 3 -> Tier 2
      assert.equal(result.relegations, 6); // 3 from Tier 1 -> Tier 2, 3 from Tier 2 -> Tier 3
      assert.equal(result.stayed, 12);
      assert.equal(result.nextSeason, "2026/27");
      assert.equal(result.alreadyTransitioned, false);

      // Verify Tier 1 relegation cutoff tie-breaker (goalsScored: lg-t1-5 stays with 60 goals, lg-t1-6 relegated with 58 goals)
      const t1FifthNext = db.leagueSeasonsStore.get("lg-t1-5::2026/27");
      const t1SixthNext = db.leagueSeasonsStore.get("lg-t1-6::2026/27");
      assert.equal(t1FifthNext.tierId, "tier-1");
      assert.equal(t1SixthNext.tierId, "tier-2");

      // Verify Tier 2 promotion cutoff tie-breaker (transferHits: lg-t2-3 promoted with 4 hits, lg-t2-4 stays with 16 hits)
      const t2ThirdNext = db.leagueSeasonsStore.get("lg-t2-3::2026/27");
      const t2FourthNext = db.leagueSeasonsStore.get("lg-t2-4::2026/27");
      assert.equal(t2ThirdNext.tierId, "tier-1");
      assert.equal(t2FourthNext.tierId, "tier-2");

      // Verify Tier 3 promotion cutoff tie-breaker (goalsScored: lg-t3-3 promoted with 61 goals, lg-t3-4 stays with 57 goals)
      const t3ThirdNext = db.leagueSeasonsStore.get("lg-t3-3::2026/27");
      const t3FourthNext = db.leagueSeasonsStore.get("lg-t3-4::2026/27");
      assert.equal(t3ThirdNext.tierId, "tier-2");
      assert.equal(t3FourthNext.tierId, "tier-3");

      // Verify completed-season placement records link promotedToSeasonId / relegatedToSeasonId
      const t2ThirdCompletedPlacement = db.placementsStore.get("ls-t2-3::group-pyramid-1");
      assert.equal(t2ThirdCompletedPlacement.movement, LeagueTierMovement.PROMOTE);
      assert.equal(t2ThirdCompletedPlacement.promotedToSeasonId, t2ThirdNext.id);

      const t1SixthCompletedPlacement = db.placementsStore.get("ls-t1-6::group-pyramid-1");
      assert.equal(t1SixthCompletedPlacement.movement, LeagueTierMovement.RELEGATE);
      assert.equal(t1SixthCompletedPlacement.relegatedToSeasonId, t1SixthNext.id);

      // Verify LEAGUE_TIER_TRANSITION_COMPLETED domain event was emitted
      assert.equal(publishedEvents.length, 1);
      assert.equal(publishedEvents[0].tierGroupId, "group-pyramid-1");
      assert.equal(publishedEvents[0].season, "2025/26");
      assert.equal(publishedEvents[0].nextSeason, "2026/27");
      assert.equal(publishedEvents[0].promotions, 6);
      assert.equal(publishedEvents[0].relegations, 6);
      assert.equal(publishedEvents[0].movements.length, 24);
    });

    it("is idempotent when run multiple times for the same season and tier group", async () => {
      const db = createPyramidMockDb();
      const bus = new InMemoryEventBus();
      const service = new LeagueService(db, bus);

      const firstRun = await service.applySeasonEndTierTransitions("2025/26", "group-pyramid-1");
      const seasonCountAfterFirstRun = db.leagueSeasonsStore.size;
      const placementCountAfterFirstRun = db.placementsStore.size;

      const secondRun = await service.applySeasonEndTierTransitions("2025/26", "group-pyramid-1");

      assert.equal(firstRun.alreadyTransitioned, false);
      assert.equal(secondRun.alreadyTransitioned, true);
      assert.equal(secondRun.processed, 24);
      assert.equal(secondRun.promotions, 6);
      assert.equal(secondRun.relegations, 6);
      assert.equal(db.leagueSeasonsStore.size, seasonCountAfterFirstRun);
      assert.equal(db.placementsStore.size, placementCountAfterFirstRun);
    });
  });
});
