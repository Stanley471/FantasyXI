import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  DraftService,
  PlayerCandidate,
  PlayerAlreadyDraftedError,
  NotYourTurnError,
} from "../services/draft/draftService.js";

describe("Strict Draft Mode & Concurrency Collision Detection (Issue 160)", () => {
  let draftService: DraftService;

  beforeEach(() => {
    draftService = new DraftService();
  });

  it("should prevent two managers from drafting the same player under simultaneous concurrency", async () => {
    const leagueId = "league-draft-001";
    const squadA = "squad-arsenal";
    const squadB = "squad-chelsea";
    const erlingHaalandId = 999;

    // Both managers simultaneously submit pick for Haaland
    const results = await Promise.allSettled([
      draftService.executeDraftPick(leagueId, squadA, erlingHaalandId),
      draftService.executeDraftPick(leagueId, squadB, erlingHaalandId),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    const rejections = results.filter((r) => r.status === "rejected");

    assert.strictEqual(successes.length, 1, "Exactly one draft pick must succeed");
    assert.strictEqual(rejections.length, 1, "The competing concurrent draft pick must be rejected");

    const failedReason = (rejections[0] as PromiseRejectedResult).reason;
    assert.ok(
      failedReason instanceof PlayerAlreadyDraftedError,
      `Expected PlayerAlreadyDraftedError, got ${failedReason}`
    );
    assert.strictEqual(failedReason.leagueId, leagueId);
    assert.strictEqual(failedReason.playerId, erlingHaalandId);

    // Verify ownership is assigned to the successful squad
    const owner = draftService.getPlayerOwner(leagueId, erlingHaalandId);
    const winningSquad = (successes[0] as PromiseFulfilledResult<any>).value.squadId;
    assert.strictEqual(owner, winningSquad);
  });

  it("should allow managers in DIFFERENT leagues to draft the same player", async () => {
    const leagueA = "league-premier-1";
    const leagueB = "league-champions-2";
    const squad1 = "squad-alpha";
    const squad2 = "squad-beta";
    const mohamedSalahId = 200;

    const pickA = await draftService.executeDraftPick(leagueA, squad1, mohamedSalahId);
    const pickB = await draftService.executeDraftPick(leagueB, squad2, mohamedSalahId);

    assert.strictEqual(pickA.playerId, mohamedSalahId);
    assert.strictEqual(pickB.playerId, mohamedSalahId);
    assert.strictEqual(draftService.getPlayerOwner(leagueA, mohamedSalahId), squad1);
    assert.strictEqual(draftService.getPlayerOwner(leagueB, mohamedSalahId), squad2);
  });

  it("should automatically pick the highest-value available player upon timer expiration", async () => {
    const leagueId = "league-draft-autopick";
    const squadA = "squad-afk-manager";

    const availablePlayers: PlayerCandidate[] = [
      { id: 1, displayName: "Budget Keeper", position: "GKP", price: 4.5, totalPoints: 40 },
      { id: 2, displayName: "Midfielder Star", position: "MID", price: 10.0, totalPoints: 120 },
      { id: 3, displayName: "Elite Striker", position: "FWD", price: 14.0, totalPoints: 210 },
      { id: 4, displayName: "Solid Defender", position: "DEF", price: 6.0, totalPoints: 95 },
    ];

    // Manager missed timer -> autoPick triggers
    const autoPick = await draftService.executeAutoPick(leagueId, squadA, availablePlayers);

    assert.strictEqual(autoPick.playerId, 3, "Should select Elite Striker (210 points)");
    assert.strictEqual(autoPick.squadId, squadA);

    // Run auto-pick for next turn, should pick the next highest available (id: 2, 120 pts)
    const squadB = "squad-manager-2";
    const secondAutoPick = await draftService.executeAutoPick(leagueId, squadB, availablePlayers);
    assert.strictEqual(secondAutoPick.playerId, 2, "Should select Midfielder Star (120 points)");
  });

  it("should synchronize real-time draft room turns and broadcast pick events", async () => {
    const leagueId = "league-live-room";
    const squadOrder = ["squad-1", "squad-2", "squad-3"];
    draftService.createDraftRoom(leagueId, squadOrder, 30);

    const receivedEvents: any[] = [];
    const unsubscribe = draftService.subscribe(leagueId, (event) => {
      receivedEvents.push(event);
    });

    // Valid turn for squad-1
    await draftService.executeDraftPick(leagueId, "squad-1", 101);

    assert.strictEqual(receivedEvents.length, 1);
    assert.strictEqual(receivedEvents[0].type, "DRAFT_PICK_MADE");
    assert.strictEqual(receivedEvents[0].nextTurn.squadId, "squad-2");

    // Attempt draft out of turn by squad-1 again -> should reject
    await assert.rejects(
      async () => draftService.executeDraftPick(leagueId, "squad-1", 102),
      NotYourTurnError
    );

    unsubscribe();
  });
});
