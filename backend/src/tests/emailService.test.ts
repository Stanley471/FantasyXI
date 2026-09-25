import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EmailService, EmailProvider, SendEmailOptions, EmailProviderResult } from "../services/email/emailService.js";

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
    assert.match(template.text, /15.00 USDC/);
    assert.match(template.text, /Weekend Winners/);
    assert.match(template.text, /Transaction Hash: abcdef/);

    assert.match(template.html, /Weekend Winners/);
    assert.match(template.html, /15.00 USDC/);
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
});
