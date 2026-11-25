import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { prisma } from "../config/db.js";
import { sendGameweekDeadlineReminders } from "../jobs/deadlineReminders.js";
import { emailService, EmailProvider } from "../services/email/emailService.js";
import type { EmailProviderResult, SendEmailOptions } from "../services/email/emailService.js";

/**
 * Mock email provider for testing.
 */
class MockEmailProvider implements EmailProvider {
  public sentEmails: SendEmailOptions[] = [];
  public shouldFail = false;
  public failureMessage = "Mock email failure";

  async sendEmail(options: SendEmailOptions): Promise<EmailProviderResult> {
    if (this.shouldFail) {
      return {
        success: false,
        error: this.failureMessage,
      };
    }

    this.sentEmails.push(options);
    return {
      success: true,
      messageId: `mock_${Date.now()}_${Math.random()}`,
    };
  }

  reset(): void {
    this.sentEmails = [];
    this.shouldFail = false;
  }
}

describe("Deadline Reminders", () => {
  let mockProvider: MockEmailProvider;

  beforeEach(() => {
    mockProvider = new MockEmailProvider();
    emailService.setProvider(mockProvider);
  });

  afterEach(() => {
    emailService.resetCaptainAlertRateLimit();
    mockProvider.reset();
  });

  it("should send reminder emails 6 hours before gameweek deadline", async () => {
    // Create test data
    const user = await prisma.user.create({
      data: {
        email: "manager@example.com",
        username: `manager_${Date.now()}`,
        passwordHash: "hash",
        deadlineReminder: true,
      },
    });

    const squad = await prisma.squad.create({
      data: {
        userId: user.id,
        name: "Test Squad",
      },
    });

    // Create gameweek with deadline 5 hours away (within 6-hour window)
    const now = new Date();
    const deadlineTime = new Date(now.getTime() + 5 * 60 * 60 * 1000);

    const gameweek = await prisma.gameweek.create({
      data: {
        fplId: 999,
        name: "Gameweek 999",
        deadline: deadlineTime,
        season: "2024/25",
      },
    });

    const league = await prisma.league.create({
      data: {
        name: "Test League",
        creatorId: user.id,
        inviteCode: `invite_${Date.now()}`,
        startGameweekId: gameweek.id,
        endGameweekId: gameweek.id,
      },
    });

    await prisma.leagueMember.create({
      data: {
        leagueId: league.id,
        userId: user.id,
        squadId: squad.id,
        status: "ACTIVE",
      },
    });

    // Create some fixture data
    const homeTeam = await prisma.team.create({
      data: {
        fplId: 1,
        name: "Home Team",
        shortName: "HT",
      },
    });

    const awayTeam = await prisma.team.create({
      data: {
        fplId: 2,
        name: "Away Team",
        shortName: "AT",
      },
    });

    await prisma.fixture.create({
      data: {
        fplId: 1,
        gameweekId: gameweek.id,
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
        kickoffTime: new Date(now.getTime() + 6 * 60 * 60 * 1000),
      },
    });

    // Run the job
    const sentCount = await sendGameweekDeadlineReminders(now);

    // Verify results
    assert.equal(sentCount, 1, "Should send 1 reminder");
    assert.equal(mockProvider.sentEmails.length, 1, "Should have 1 sent email");

    const sentEmail = mockProvider.sentEmails[0];
    assert.equal(sentEmail.to, "manager@example.com");
    assert(sentEmail.subject.includes("Deadline Reminder"));
    assert(sentEmail.subject.includes("Gameweek 999"));
    assert(sentEmail.html.includes("Gameweek Deadline Reminder"));
    assert(sentEmail.html.includes("Test Squad"));
    assert(sentEmail.text.includes("Test League"));

    // Verify deduplication record was created
    const reminder = await prisma.gameweekDeadlineReminder.findUnique({
      where: {
        userId_gameweekId: {
          userId: user.id,
          gameweekId: gameweek.id,
        },
      },
    });
    assert(reminder, "Should have created deduplication record");

    // Cleanup
    await prisma.gameweekDeadlineReminder.deleteMany({ where: { userId: user.id } });
    await prisma.fixture.deleteMany({ where: { gameweekId: gameweek.id } });
    await prisma.leagueMember.deleteMany({ where: { leagueId: league.id } });
    await prisma.league.deleteMany({ where: { id: league.id } });
    await prisma.gameweek.delete({ where: { id: gameweek.id } });
    await prisma.squad.delete({ where: { id: squad.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.team.deleteMany({ where: { fplId: { in: [1, 2] } } });
  });

  it("should not send reminder to users with deadlineReminder disabled", async () => {
    const user = await prisma.user.create({
      data: {
        email: "opted_out@example.com",
        username: `user_${Date.now()}`,
        passwordHash: "hash",
        deadlineReminder: false, // Opted out
      },
    });

    const squad = await prisma.squad.create({
      data: {
        userId: user.id,
        name: "Test Squad",
      },
    });

    const now = new Date();
    const deadlineTime = new Date(now.getTime() + 5 * 60 * 60 * 1000);

    const gameweek = await prisma.gameweek.create({
      data: {
        fplId: 998,
        name: "Gameweek 998",
        deadline: deadlineTime,
        season: "2024/25",
      },
    });

    const league = await prisma.league.create({
      data: {
        name: "Test League",
        creatorId: user.id,
        inviteCode: `invite_${Date.now()}`,
        startGameweekId: gameweek.id,
        endGameweekId: gameweek.id,
      },
    });

    await prisma.leagueMember.create({
      data: {
        leagueId: league.id,
        userId: user.id,
        squadId: squad.id,
        status: "ACTIVE",
      },
    });

    // Run the job
    const sentCount = await sendGameweekDeadlineReminders(now);

    // Verify no email was sent
    assert.equal(sentCount, 0, "Should not send reminder to opted-out user");
    assert.equal(mockProvider.sentEmails.length, 0, "Should have 0 sent emails");

    // Cleanup
    await prisma.leagueMember.deleteMany({ where: { leagueId: league.id } });
    await prisma.league.deleteMany({ where: { id: league.id } });
    await prisma.gameweek.delete({ where: { id: gameweek.id } });
    await prisma.squad.delete({ where: { id: squad.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("should not send duplicate reminders for the same gameweek", async () => {
    const user = await prisma.user.create({
      data: {
        email: "manager@example.com",
        username: `manager_${Date.now()}`,
        passwordHash: "hash",
        deadlineReminder: true,
      },
    });

    const squad = await prisma.squad.create({
      data: {
        userId: user.id,
        name: "Test Squad",
      },
    });

    const now = new Date();
    const deadlineTime = new Date(now.getTime() + 5 * 60 * 60 * 1000);

    const gameweek = await prisma.gameweek.create({
      data: {
        fplId: 997,
        name: "Gameweek 997",
        deadline: deadlineTime,
        season: "2024/25",
      },
    });

    const league = await prisma.league.create({
      data: {
        name: "Test League",
        creatorId: user.id,
        inviteCode: `invite_${Date.now()}`,
        startGameweekId: gameweek.id,
        endGameweekId: gameweek.id,
      },
    });

    await prisma.leagueMember.create({
      data: {
        leagueId: league.id,
        userId: user.id,
        squadId: squad.id,
        status: "ACTIVE",
      },
    });

    // Manually create a reminder record to simulate already sent
    await prisma.gameweekDeadlineReminder.create({
      data: {
        userId: user.id,
        gameweekId: gameweek.id,
      },
    });

    // Run the job
    const sentCount = await sendGameweekDeadlineReminders(now);

    // Verify no email was sent (deduplication worked)
    assert.equal(sentCount, 0, "Should not send duplicate reminder");
    assert.equal(mockProvider.sentEmails.length, 0, "Should have 0 sent emails");

    // Cleanup
    await prisma.gameweekDeadlineReminder.deleteMany({ where: { userId: user.id } });
    await prisma.leagueMember.deleteMany({ where: { leagueId: league.id } });
    await prisma.league.deleteMany({ where: { id: league.id } });
    await prisma.gameweek.delete({ where: { id: gameweek.id } });
    await prisma.squad.delete({ where: { id: squad.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("should not send reminder if gameweek is outside 6-hour window", async () => {
    const user = await prisma.user.create({
      data: {
        email: "manager@example.com",
        username: `manager_${Date.now()}`,
        passwordHash: "hash",
        deadlineReminder: true,
      },
    });

    const squad = await prisma.squad.create({
      data: {
        userId: user.id,
        name: "Test Squad",
      },
    });

    const now = new Date();
    const farFutureDeadline = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours away

    const gameweek = await prisma.gameweek.create({
      data: {
        fplId: 996,
        name: "Gameweek 996",
        deadline: farFutureDeadline,
        season: "2024/25",
      },
    });

    const league = await prisma.league.create({
      data: {
        name: "Test League",
        creatorId: user.id,
        inviteCode: `invite_${Date.now()}`,
        startGameweekId: gameweek.id,
        endGameweekId: gameweek.id,
      },
    });

    await prisma.leagueMember.create({
      data: {
        leagueId: league.id,
        userId: user.id,
        squadId: squad.id,
        status: "ACTIVE",
      },
    });

    // Run the job
    const sentCount = await sendGameweekDeadlineReminders(now);

    // Verify no email was sent (outside window)
    assert.equal(sentCount, 0, "Should not send reminder outside 6-hour window");
    assert.equal(mockProvider.sentEmails.length, 0, "Should have 0 sent emails");

    // Cleanup
    await prisma.leagueMember.deleteMany({ where: { leagueId: league.id } });
    await prisma.league.deleteMany({ where: { id: league.id } });
    await prisma.gameweek.delete({ where: { id: gameweek.id } });
    await prisma.squad.delete({ where: { id: squad.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("should handle email provider failures gracefully", async () => {
    mockProvider.shouldFail = true;
    mockProvider.failureMessage = "SMTP connection failed";

    const user = await prisma.user.create({
      data: {
        email: "manager@example.com",
        username: `manager_${Date.now()}`,
        passwordHash: "hash",
        deadlineReminder: true,
      },
    });

    const squad = await prisma.squad.create({
      data: {
        userId: user.id,
        name: "Test Squad",
      },
    });

    const now = new Date();
    const deadlineTime = new Date(now.getTime() + 5 * 60 * 60 * 1000);

    const gameweek = await prisma.gameweek.create({
      data: {
        fplId: 995,
        name: "Gameweek 995",
        deadline: deadlineTime,
        season: "2024/25",
      },
    });

    const league = await prisma.league.create({
      data: {
        name: "Test League",
        creatorId: user.id,
        inviteCode: `invite_${Date.now()}`,
        startGameweekId: gameweek.id,
        endGameweekId: gameweek.id,
      },
    });

    await prisma.leagueMember.create({
      data: {
        leagueId: league.id,
        userId: user.id,
        squadId: squad.id,
        status: "ACTIVE",
      },
    });

    // Run the job - should not throw despite email failure
    const sentCount = await sendGameweekDeadlineReminders(now);

    // Verify no reminder was recorded due to failure
    assert.equal(sentCount, 0, "Should not count failed emails as sent");

    const reminder = await prisma.gameweekDeadlineReminder.findUnique({
      where: {
        userId_gameweekId: {
          userId: user.id,
          gameweekId: gameweek.id,
        },
      },
    });
    assert(!reminder, "Should not create deduplication record on email failure");

    // Cleanup
    await prisma.leagueMember.deleteMany({ where: { leagueId: league.id } });
    await prisma.league.deleteMany({ where: { id: league.id } });
    await prisma.gameweek.delete({ where: { id: gameweek.id } });
    await prisma.squad.delete({ where: { id: squad.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
