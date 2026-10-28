import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EmailService,
  EmailProvider,
  SendEmailOptions,
  EmailProviderResult,
} from "../services/email/emailService.js";
import { FplSyncService } from "../services/fpl/fplSyncService.js";
import { InMemoryEventBus } from "../services/events/eventBus.js";
import {
  CAPTAIN_INJURY_ALERT_EVENT,
  type CaptainInjuryAlertPayload,
} from "../services/events/domainEvents.js";

class MockEmailProvider implements EmailProvider {
  public sent: SendEmailOptions[] = [];

  async sendEmail(options: SendEmailOptions): Promise<EmailProviderResult> {
    this.sent.push(options);
    return { success: true, messageId: `msg_${this.sent.length}` };
  }
}

describe("EmailService", () => {
  it("should generate proper deposit confirmation email subject, text, and html", () => {
    const service = new EmailService();
    const template = service.generateDepositConfirmationTemplate({
      to: "user@example.com",
      username: "Alex",
      leagueName: "Weekend Winners",
      amount: 15.0,
      txHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    });

    assert.equal(template.subject, "Deposit Confirmed: 15.00 USDC for Weekend Winners");
    assert.match(template.text, /Hello Alex/);
    assert.match(template.text, /15\.00 USDC/);
    assert.match(template.text, /Weekend Winners/);
    assert.match(template.text, /Transaction Hash: abcdef/);

    assert.match(template.html, /Weekend Winners/);
    assert.match(template.html, /15\.00 USDC/);
    assert.match(template.html, /abcdef1234567890/);
    assert.match(template.html, /Deposit Confirmed/);
  });

  it("should send deposit confirmation email via configured provider", async () => {
    const provider = new MockEmailProvider();
    const service = new EmailService(provider);

    const result = await service.sendDepositConfirmation({
      to: "test@example.com",
      username: "John",
      leagueName: "High Rollers",
      amount: 50,
      txHash: "hash123",
    });

    assert.equal(result.success, true);
    assert.equal(result.messageId, "msg_1");
    assert.equal(provider.sent.length, 1);
    assert.equal(provider.sent[0].to, "test@example.com");
    assert.equal(provider.sent[0].subject, "Deposit Confirmed: 50.00 USDC for High Rollers");
  });

  it("should generate CaptainInjuryAlertEmail template with manager name, captain name, news, and direct link", () => {
    const service = new EmailService();
    const template = service.generateCaptainInjuryAlertTemplate({
      to: "pep@example.com",
      managerName: "Pep Guardiola",
      captainName: "Erling Haaland",
      squadId: "squad-101",
      squadName: "Treble Winners FC",
      playerId: 9,
      gameweekId: 12,
      gameweekName: "Gameweek 12",
      status: "i",
      news: "Hamstring injury - expected back Dec 01",
      chanceOfPlayingNextRound: 0,
      teamManagementUrl: "https://fantasyxi.app/team?squadId=squad-101",
    });

    assert.equal(template.subject, "Captain Alert: Erling Haaland is Injured (Gameweek 12)");
    assert.match(template.text, /Hello Pep Guardiola/);
    assert.match(template.text, /Erling Haaland/);
    assert.match(template.text, /Injured \(i\)/);
    assert.match(template.text, /Hamstring injury - expected back Dec 01/);
    assert.match(template.text, /https:\/\/fantasyxi\.app\/team\?squadId=squad-101/);

    assert.match(template.html, /Pep Guardiola/);
    assert.match(template.html, /Erling Haaland/);
    assert.match(template.html, /Hamstring injury - expected back Dec 01/);
    assert.match(template.html, /https:\/\/fantasyxi\.app\/team\?squadId=squad-101/);
  });

  it("should rate-limit duplicate captain injury alert emails for the same injury in the same gameweek", async () => {
    const provider = new MockEmailProvider();
    const service = new EmailService(provider);

    const payload = {
      to: "manager@example.com",
      managerName: "Mikel",
      captainName: "Bukayo Saka",
      squadId: "squad-ars",
      playerId: 7,
      gameweekId: 15,
      gameweekName: "Gameweek 15",
      status: "d",
      news: "Knock - 75% chance of playing",
    };

    const first = await service.enqueueCaptainInjuryAlertEmail(payload);
    assert.equal(first.success, true);
    assert.equal(first.skipped, undefined);
    assert.equal(provider.sent.length, 1);

    // Second dispatch for same squad, player, status, and gameweek must be suppressed
    const duplicate = await service.enqueueCaptainInjuryAlertEmail(payload);
    assert.equal(duplicate.success, true);
    assert.equal(duplicate.skipped, true);
    assert.equal(duplicate.reason, "DUPLICATE_GAMEWEEK_ALERT");
    assert.equal(provider.sent.length, 1);

    // Different gameweek should allow sending again
    const nextGw = await service.enqueueCaptainInjuryAlertEmail({
      ...payload,
      gameweekId: 16,
      gameweekName: "Gameweek 16",
    });
    assert.equal(nextGw.success, true);
    assert.equal(nextGw.skipped, undefined);
    assert.equal(provider.sent.length, 2);
  });
});

describe("FplSyncService Captain Injury Notification Trigger (Issue #238)", () => {
  function createMockSyncEnvironment(initialPlayerStatus = "a") {
    const futureDeadline = new Date(Date.now() + 48 * 3600 * 1000);
    const state = {
      teams: [{ id: 1, fplId: 1, name: "Arsenal", shortName: "ARS" }],
      gameweeks: [
        {
          id: 5,
          fplId: 5,
          name: "Gameweek 5",
          deadline: futureDeadline,
          isCurrent: true,
          isFinished: false,
          season: "2026/27",
        },
      ],
      players: [
        {
          id: 100,
          fplId: 300,
          firstName: "Bukayo",
          lastName: "Saka",
          displayName: "Saka",
          position: "MID",
          teamId: 1,
          price: 10.5,
          totalPoints: 80,
          minutesPlayed: 900,
          goalsScored: 6,
          assists: 5,
          cleanSheets: 4,
          form: 7.2,
          status: initialPlayerStatus,
          news: null as string | null,
          chanceOfPlayingNextRound: 100 as number | null,
          selectedByPercent: 45.0,
          photoUrl: "https://resources.premierleague.com/premierleague/photos/players/250x250/p223340.png",
          isAvailable: initialPlayerStatus === "a",
        },
      ],
      squadPlayers: [
        {
          id: 1,
          squadId: "squad-captain-1",
          playerId: 100,
          isCaptain: true,
          isViceCaptain: false,
          isStarter: true,
          squad: {
            id: "squad-captain-1",
            name: "North London XI",
            user: {
              id: "user-1",
              email: "captain.manager@example.com",
              username: "arteta_fan",
              name: "Alex Manager",
            },
          },
        },
        {
          id: 2,
          squadId: "squad-non-captain-2",
          playerId: 100,
          isCaptain: false,
          isViceCaptain: true,
          isStarter: true,
          squad: {
            id: "squad-non-captain-2",
            name: "Bench Warmers",
            user: {
              id: "user-2",
              email: "vice.manager@example.com",
              username: "vice_only",
              name: "Bob Vice",
            },
          },
        },
      ],
    };

    const db = {
      state,
      team: {
        findMany: async () => state.teams,
        upsert: async ({ create, update }: any) => create ?? update,
      },
      gameweek: {
        findMany: async () => state.gameweeks,
        upsert: async ({ create, update }: any) => create ?? update,
      },
      player: {
        findMany: async () => state.players,
        findUnique: async ({ where }: any) =>
          state.players.find((p) => p.fplId === where.fplId || p.id === where.id) ?? null,
        upsert: async ({ where, update }: any) => {
          const existing = state.players.find((p) => p.fplId === where.fplId);
          if (existing) Object.assign(existing, update);
          return existing;
        },
      },
      squadPlayer: {
        findMany: async ({ where }: any) =>
          state.squadPlayers.filter(
            (sp) =>
              sp.playerId === where.playerId &&
              (where.isCaptain === undefined || sp.isCaptain === where.isCaptain)
          ),
      },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    };

    const makeClient = (incomingStatus: string, news: string, chance: number | null) => ({
      getBootstrapStatic: async () => ({
        teams: [
          {
            id: 1,
            name: "Arsenal",
            short_name: "ARS",
            code: 3,
            strength: 5,
            strength_overall_home: 1350,
            strength_overall_away: 1360,
            strength_attack_home: 1340,
            strength_attack_away: 1350,
            strength_defence_home: 1340,
            strength_defence_away: 1350,
          },
        ],
        events: [
          {
            id: 5,
            name: "Gameweek 5",
            deadline_time: futureDeadline.toISOString(),
            is_current: true,
            finished: false,
          },
        ],
        elements: [
          {
            id: 300,
            first_name: "Bukayo",
            second_name: "Saka",
            web_name: "Saka",
            element_type: 3,
            team: 1,
            now_cost: 105,
            total_points: 80,
            minutes: 900,
            goals_scored: 6,
            assists: 5,
            clean_sheets: 4,
            form: "7.2",
            status: incomingStatus,
            news,
            chance_of_playing_next_round: chance,
            selected_by_percent: "45.0",
            photo: "223340.jpg",
          },
        ],
      }),
    });

    return { db, makeClient };
  }

  it("dispatches email job and domain event when captain status changes to 'i' (injured), 'd' (doubtful), or 's' (suspended)", async () => {
    const { db, makeClient } = createMockSyncEnvironment("a");
    const provider = new MockEmailProvider();
    const email = new EmailService(provider);
    const bus = new InMemoryEventBus();

    const receivedEvents: CaptainInjuryAlertPayload[] = [];
    bus.subscribe<CaptainInjuryAlertPayload>(CAPTAIN_INJURY_ALERT_EVENT, (payload) => {
      receivedEvents.push(payload);
    });

    const syncService = new FplSyncService({
      db,
      client: makeClient("i", "Knee injury - ruled out of weekend fixture", 0) as any,
      email,
      bus,
      teamManagementBaseUrl: "https://fantasyxi.app",
    });

    const result = await syncService.syncBootstrap();
    assert.equal(result.captainAlertsDispatched, 1);

    // Domain event published once for the injured player
    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0].playerId, 100);
    assert.equal(receivedEvents[0].oldStatus, "a");
    assert.equal(receivedEvents[0].newStatus, "i");

    // Only the manager who has Saka as current captain receives the email (not user-2 vice-captain)
    assert.equal(provider.sent.length, 1);
    assert.equal(provider.sent[0].to, "captain.manager@example.com");
    assert.match(provider.sent[0].subject, /Captain Alert: Saka is Injured/);
    assert.match(provider.sent[0].text, /Hello Alex Manager/);
    assert.match(provider.sent[0].text, /Knee injury - ruled out of weekend fixture/);
    assert.match(provider.sent[0].text, /https:\/\/fantasyxi\.app\/team\?squadId=squad-captain-1/);
  });

  it("dispatches email when player status changes to 'd' (doubtful) and rate-limits duplicate syncs in the same gameweek", async () => {
    const { db, makeClient } = createMockSyncEnvironment("a");
    const provider = new MockEmailProvider();
    const email = new EmailService(provider);
    const bus = new InMemoryEventBus();

    const syncService = new FplSyncService({
      db,
      client: makeClient("d", "Tight hamstring - 50% chance of playing", 50) as any,
      email,
      bus,
    });

    const firstSync = await syncService.syncBootstrap();
    assert.equal(firstSync.captainAlertsDispatched, 1);
    assert.equal(provider.sent.length, 1);
    assert.match(provider.sent[0].subject, /Captain Alert: Saka is Doubtful/);

    // Simulate player flapping back to 'a' then 'd' again in the same gameweek:
    // rate limiter ensures no duplicate email for the same injury status in the same gameweek.
    db.state.players[0].status = "a";
    const secondSync = await syncService.syncBootstrap();
    assert.equal(secondSync.captainAlertsDispatched, 0);
    assert.equal(provider.sent.length, 1);
  });
});
