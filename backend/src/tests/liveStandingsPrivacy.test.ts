import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskLiveSnapshotForViewer, type LiveSnapshot } from "../services/live/liveService.js";
import {
  LiveProvisionalLeaderboardService,
  maskProvisionalDiffPayloadForViewer,
  type LeagueRankDiffPayload,
} from "../services/live/liveProvisionalLeaderboardService.js";
import { managerAliasForUserId } from "../services/privacy/displayName.js";

const ALICE_ALIAS = managerAliasForUserId("user-alice");

function snapshot(): LiveSnapshot {
  return {
    leagueId: "league-1",
    gameweek: { id: 3, name: "Gameweek 3" },
    fixtures: [],
    events: [],
    standings: [
      {
        rank: 1,
        userId: "user-alice",
        username: "alice",
        isAnonymous: true,
        squadId: "s-alice",
        squadName: "Alice Athletic",
        membershipStatus: "ACTIVE" as never,
        totalPoints: 64,
        livePoints: 24,
        lineup: [],
      },
      {
        rank: 2,
        userId: "user-bob",
        username: "bob",
        isAnonymous: false,
        squadId: "s-bob",
        squadName: "Bob's Ballers",
        membershipStatus: "ACTIVE" as never,
        totalPoints: 42,
        livePoints: 42,
        lineup: [],
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

describe("live snapshot masking (issue #511)", () => {
  it("aliases anonymous managers for signed-out and other viewers", () => {
    assert.equal(maskLiveSnapshotForViewer(snapshot()).standings[0].username, ALICE_ALIAS);
    assert.equal(
      maskLiveSnapshotForViewer(snapshot(), { id: "user-bob", role: "USER" }).standings[0].username,
      ALICE_ALIAS
    );
    assert.equal(maskLiveSnapshotForViewer(snapshot()).standings[1].username, "bob");
  });

  it("shows the real name to the manager themselves and to platform admins", () => {
    assert.equal(
      maskLiveSnapshotForViewer(snapshot(), { id: "user-alice", role: "USER" }).standings[0].username,
      "alice"
    );
    assert.equal(
      maskLiveSnapshotForViewer(snapshot(), { id: "user-admin", role: "ADMIN" }).standings[0].username,
      "alice"
    );
  });

  it("does not mutate the cached (raw) snapshot", () => {
    const raw = snapshot();
    const masked = maskLiveSnapshotForViewer(raw);
    assert.equal(masked.standings[0].username, ALICE_ALIAS);
    assert.equal(raw.standings[0].username, "alice");
    assert.notEqual(masked, raw);
  });
});

describe("provisional leaderboard masking (issue #511)", () => {
  async function registeredService() {
    const service = new LiveProvisionalLeaderboardService({ db: {}, redis: null, fanout: null });
    await service.registerSquads(5, [
      {
        squadId: "s-alice",
        userId: "user-alice",
        username: "alice",
        isAnonymous: true,
        squadName: "Alice Athletic",
        leagueIds: ["league-1"],
        basePoints: 100,
        players: [],
      },
      {
        squadId: "s-bob",
        userId: "user-bob",
        username: "bob",
        isAnonymous: false,
        squadName: "Bob's Ballers",
        leagueIds: ["league-1"],
        basePoints: 90,
        players: [],
      },
    ]);
    return service;
  }

  it("aliases anonymous managers in snapshot reads for public viewers", async () => {
    const service = await registeredService();
    const pub = service.getLeagueLeaderboard("league-1");
    assert.equal(pub.find((e) => e.squadId === "s-alice")!.username, ALICE_ALIAS);
    assert.equal(pub.find((e) => e.squadId === "s-bob")!.username, "bob");
    assert.equal(pub.find((e) => e.squadId === "s-alice")!.isAnonymous, true);
  });

  it("shows the real name to self and admins in snapshot reads", async () => {
    const service = await registeredService();
    assert.equal(
      service.getLeagueLeaderboard("league-1", { id: "user-alice", role: "USER" }).find((e) => e.squadId === "s-alice")!
        .username,
      "alice"
    );
    assert.equal(
      service.getLeagueLeaderboard("league-1", { id: "user-admin", role: "ADMIN" }).find((e) => e.squadId === "s-alice")!
        .username,
      "alice"
    );
    assert.equal(
      service.getSquadLeaguePosition("league-1", "s-alice", { id: "user-bob", role: "USER" })!.username,
      ALICE_ALIAS
    );
    assert.equal(
      service.getSquadLeaguePosition("league-1", "s-alice", { id: "user-alice", role: "USER" })!.username,
      "alice"
    );
  });

  it("masks broadcast diff payloads per viewer without mutating the shared payload", () => {
    const payload: LeagueRankDiffPayload = {
      leagueId: "league-1",
      gameweekId: 5,
      updatedAt: new Date().toISOString(),
      diffs: [
        {
          squadId: "s-alice",
          userId: "user-alice",
          username: "alice",
          isAnonymous: true,
          squadName: "Alice Athletic",
          oldRank: 2,
          newRank: 1,
          rankDelta: 1,
          oldPoints: 100,
          newPoints: 106,
          pointsDelta: 6,
          livePoints: 6,
        },
      ],
    };
    const pub = maskProvisionalDiffPayloadForViewer(payload);
    assert.equal(pub.diffs[0].username, ALICE_ALIAS);
    assert.equal(payload.diffs[0].username, "alice");
    assert.equal(
      maskProvisionalDiffPayloadForViewer(payload, { id: "user-alice", role: "USER" }).diffs[0].username,
      "alice"
    );
  });
});
