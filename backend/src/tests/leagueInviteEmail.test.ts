import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  LeagueService,
  LeagueValidationError,
} from "../services/league/leagueService.js";
import { EmailService } from "../services/email/emailService.js";
import type {
  EmailProvider,
  EmailProviderResult,
  SendEmailOptions,
} from "../services/email/emailService.js";
import { inviteLeagueMemberByEmail } from "../controllers/league.controller.js";
import { leagueService as sharedLeagueService } from "../services/league/leagueService.js";
import { createLeagueInviteRateLimiter } from "../middleware/leagueInviteRateLimiter.js";
import { MemorySlidingWindowStore } from "../middleware/rateLimiter.js";
import { executeLeagueInviteEmailTask } from "../queues/leagueInviteQueue.js";
import { LeagueStatus } from "../types/index.js";

const CREATOR = "creator-1";

function createMockDb() {
  const state = { leagues: [] as any[], invitations: [] as any[] };
  const league = {
    id: randomUUID(),
    name: "Office League",
    creatorId: CREATOR,
    entryFee: 25,
    isPrivate: true,
    status: LeagueStatus.UPCOMING,
  };
  state.leagues.push(league);

  const db: any = {
    state,
    league: {
      findUnique: async ({ where }: any) => {
        const found = state.leagues.find((l) => l.id === where.id);
        return found ? { ...found } : null;
      },
    },
    leagueInvitation: {
      create: async ({ data }: any) => {
        const invitation = { id: randomUUID(), usesCount: 0, createdAt: new Date(), ...data };
        state.invitations.push(invitation);
        return { ...invitation };
      },
    },
  };
  return db;
}

/** Mock transporter capturing every send, standing in for the real mail provider. */
class MockEmailProvider implements EmailProvider {
  public sent: SendEmailOptions[] = [];
  async sendEmail(options: SendEmailOptions): Promise<EmailProviderResult> {
    this.sent.push(options);
    return { success: true, messageId: `mock_${this.sent.length}` };
  }
}

describe("League email invites (issue #495)", () => {
  describe("LeagueService.createInvitationEmail", () => {
    it("creates a single-use invitation and returns the league fields the email needs", async () => {
      const db = createMockDb();
      const service = new LeagueService(db);

      const { invitation, email, league } = await service.createInvitationEmail(
        db.state.leagues[0].id,
        CREATOR,
        "friend@example.com"
      );

      assert.equal(email, "friend@example.com");
      assert.equal(league.name, "Office League");
      assert.equal(league.entryFee, 25);
      assert.equal(db.state.invitations[0].maxUses, 1);
      assert.ok(invitation.token.length >= 43);
    });

    it("rejects malformed recipient addresses before creating an invitation", async () => {
      const db = createMockDb();
      const service = new LeagueService(db);

      await assert.rejects(
        () => service.createInvitationEmail(db.state.leagues[0].id, CREATOR, "not-an-email"),
        LeagueValidationError
      );
      assert.equal(db.state.invitations.length, 0);
    });
  });

  describe("EmailService.sendLeagueInviteEmail", () => {
    it("sends a branded email with the league name, entry fee and join link", async () => {
      const provider = new MockEmailProvider();
      const service = new EmailService(provider);

      await service.sendLeagueInviteEmail({
        to: "friend@example.com",
        leagueName: "Office League",
        entryFee: 25,
        inviteUrl: "https://fantasyxi.app/leagues/invitations/abc123",
        inviterName: "Alex",
      });

      assert.equal(provider.sent.length, 1);
      const sent = provider.sent[0];
      assert.equal(sent.to, "friend@example.com");
      assert.match(sent.subject, /Office League/);
      assert.match(sent.html, /Office League/);
      assert.match(sent.html, /25\.00 USDC/);
      assert.match(sent.html, /https:\/\/fantasyxi\.app\/leagues\/invitations\/abc123/);
      assert.match(sent.text, /https:\/\/fantasyxi\.app\/leagues\/invitations\/abc123/);
    });

    it("labels a free league instead of printing a zero fee", async () => {
      const provider = new MockEmailProvider();
      const service = new EmailService(provider);

      await service.sendLeagueInviteEmail({
        to: "friend@example.com",
        leagueName: "Sunday League",
        entryFee: 0,
        inviteUrl: "https://fantasyxi.app/leagues/invitations/xyz",
      });

      assert.match(provider.sent[0].html, /Free entry/);
    });
  });

  describe("league-invite-email queue task", () => {
    it("dispatches the queued task through the shared email service", async () => {
      const provider = new MockEmailProvider();
      const originalProvider = (await import("../services/email/emailService.js")).emailService.getProvider();
      (await import("../services/email/emailService.js")).emailService.setProvider(provider);

      try {
        const result = await executeLeagueInviteEmailTask({
          to: "friend@example.com",
          leagueName: "Office League",
          entryFee: 25,
          inviteUrl: "https://fantasyxi.app/leagues/invitations/abc123",
        });

        assert.equal(result.success, true);
        assert.equal(provider.sent.length, 1);
        assert.equal(provider.sent[0].to, "friend@example.com");
      } finally {
        (await import("../services/email/emailService.js")).emailService.setProvider(originalProvider);
      }
    });
  });

  describe("POST /:id/invite controller", () => {
    it("queues the email and responds 202 without waiting on delivery", async () => {
      const db = createMockDb();
      const service = new LeagueService(db);
      const originalCreate = sharedLeagueService.createInvitationEmail;
      (sharedLeagueService as any).createInvitationEmail = service.createInvitationEmail.bind(service);

      const provider = new MockEmailProvider();
      const { emailService } = await import("../services/email/emailService.js");
      const originalProvider = emailService.getProvider();
      emailService.setProvider(provider);

      try {
        let statusCode = 0;
        let body: any;
        const res = {
          status(code: number) {
            statusCode = code;
            return this;
          },
          json(value: any) {
            body = value;
            return this;
          },
        };

        await inviteLeagueMemberByEmail(
          {
            user: { id: CREATOR, username: "Alex" },
            params: { id: db.state.leagues[0].id },
            body: { email: "friend@example.com" },
          } as any,
          res as any,
          (() => assert.fail("unexpected error path")) as any
        );

        assert.equal(statusCode, 202);
        assert.equal(body.success, true);
        assert.ok(body.data.invitationId);

        // The fallback (no job queue running in tests) dispatches without blocking
        // the response; by the time we check, the mock transporter has the send.
        assert.equal(provider.sent.length, 1);
        assert.equal(provider.sent[0].to, "friend@example.com");
        assert.match(provider.sent[0].html, /Alex/);
      } finally {
        (sharedLeagueService as any).createInvitationEmail = originalCreate;
        emailService.setProvider(originalProvider);
      }
    });

    it("rejects unauthenticated requests", async () => {
      let statusCode = 0;
      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json() {
          return this;
        },
      };
      await inviteLeagueMemberByEmail(
        { user: undefined, params: { id: "league-1" }, body: { email: "a@b.com" } } as any,
        res as any,
        (() => assert.fail("auth check should short-circuit")) as any
      );
      assert.equal(statusCode, 401);
    });
  });

  describe("leagueInviteRateLimiter", () => {
    it("allows up to the configured limit then blocks with 429", async () => {
      const limiter = createLeagueInviteRateLimiter({
        store: new MemorySlidingWindowStore(),
        limit: 3,
        windowMs: 60_000,
      });

      const req = { user: { id: "rate-user" } } as any;
      let statusCode = 0;
      let nextCalled = 0;
      const res = {
        setHeader() {},
        status(code: number) {
          statusCode = code;
          return this;
        },
        json() {
          return this;
        },
      };
      const next = () => nextCalled++;

      for (let i = 0; i < 3; i++) {
        await limiter(req, res as any, next);
      }
      assert.equal(nextCalled, 3);

      await limiter(req, res as any, next);
      assert.equal(statusCode, 429);
      assert.equal(nextCalled, 3);
    });

    it("tracks each user independently", async () => {
      const limiter = createLeagueInviteRateLimiter({
        store: new MemorySlidingWindowStore(),
        limit: 1,
        windowMs: 60_000,
      });
      let nextCalled = 0;
      const res = { setHeader() {}, status() { return this; }, json() { return this; } };
      const next = () => nextCalled++;

      await limiter({ user: { id: "user-a" } } as any, res as any, next);
      await limiter({ user: { id: "user-b" } } as any, res as any, next);
      assert.equal(nextCalled, 2);
    });
  });
});
