/**
 * Email Service — Transactional Email Dispatcher
 *
 * Handles sending transactional emails via REST APIs (e.g. Resend, SendGrid)
 * or mock providers during testing/development.
 */

export interface DepositConfirmationEmailPayload {
  to: string;
  username?: string;
  leagueName: string;
  amount: number | string;
  txHash?: string;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProviderResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface EmailProvider {
  sendEmail(options: SendEmailOptions): Promise<EmailProviderResult>;
}

/**
 * Resend / SendGrid transactional email provider implementation using standard fetch API
 */
export class ResendEmailProvider implements EmailProvider {
  private readonly apiKey: string;
  private readonly fromEmail: string;

  constructor(apiKey?: string, fromEmail?: string) {
    this.apiKey = apiKey || process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY || "";
    this.fromEmail = fromEmail || process.env.EMAIL_FROM || "notifications@fantasyxi.app";
  }

  async sendEmail(options: SendEmailOptions): Promise<EmailProviderResult> {
    if (!this.apiKey) {
      console.log(
        `[EmailService] No API key configured. Mock dispatching email to ${options.to}: "${options.subject}"`
      );
      return { success: true, messageId: `mock_${Date.now()}` };
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [options.to],
          subject: options.subject,
          text: options.text,
          html: options.html,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          success: false,
          error: `Email provider API error: ${response.status} - ${errText}`,
        };
      }

      const data = (await response.json()) as { id?: string };
      return { success: true, messageId: data.id };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

export class EmailService {
  constructor(private provider: EmailProvider = new ResendEmailProvider()) {}

  public getProvider(): EmailProvider {
    return this.provider;
  }

  public setProvider(provider: EmailProvider): void {
    this.provider = provider;
  }

  /**
   * Generates clean templated text and HTML body for USDC deposit confirmation.
   * Dispatched upon successful on-chain transaction verification.
   */
  public generateDepositConfirmationTemplate(payload: DepositConfirmationEmailPayload): {
    subject: string;
    text: string;
    html: string;
  } {
    const { username = "Manager", leagueName, amount, txHash } = payload;
    const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;
    const formattedAmount = isNaN(numAmount) ? String(amount) : numAmount.toFixed(2);
    const subject = `Deposit Confirmed: ${formattedAmount} USDC for ${leagueName}`;

    const text = [
      `Hello ${username},`,
      ``,
      `Your USDC deposit of ${formattedAmount} USDC for the league "${leagueName}" has been successfully confirmed on-chain!`,
      txHash ? `Transaction Hash: ${txHash}` : "",
      ``,
      `Your league membership is now ACTIVE. Good luck for the upcoming gameweek!`,
      ``,
      `Best regards,`,
      `The FantasyXI Team`,
    ]
      .filter(Boolean)
      .join("\n");

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 24px;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #1e293b; border-radius: 8px; padding: 32px; border: 1px solid #334155;">
    <h2 style="color: #38bdf8; margin-top: 0;">Deposit Confirmed! ⚽⚡</h2>
    <p>Hello <strong>${username}</strong>,</p>
    <p>Your USDC deposit for entering <strong>${leagueName}</strong> has been confirmed on the Stellar network.</p>
    
    <div style="background-color: #0f172a; padding: 16px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #38bdf8;">
      <p style="margin: 4px 0;"><strong>League:</strong> ${leagueName}</p>
      <p style="margin: 4px 0;"><strong>Deposit Amount:</strong> ${formattedAmount} USDC</p>
      ${txHash ? `<p style="margin: 4px 0; word-break: break-all;"><strong>Transaction Hash:</strong> <code style="color: #93c5fd;">${txHash}</code></p>` : ""}
      <p style="margin: 4px 0;"><strong>Status:</strong> <span style="color: #4ade80; font-weight: bold;">CONFIRMED</span></p>
    </div>

    <p>Your membership is now active and ready for the gameweek deadline.</p>

    <hr style="border: 0; border-top: 1px solid #334155; margin: 24px 0;" />
    <p style="font-size: 12px; color: #94a3b8; text-align: center;">
      This is an automated notification from FantasyXI Financial Services.
    </p>
  </div>
</body>
</html>
    `.trim();

    return { subject, text, html };
  }

  /**
   * Sends an automated email notification to the user upon a confirmed USDC deposit.
   */
  public async sendDepositConfirmation(
    payload: DepositConfirmationEmailPayload
  ): Promise<EmailProviderResult> {
    const { subject, text, html } = this.generateDepositConfirmationTemplate(payload);
    return this.provider.sendEmail({
      to: payload.to,
      subject,
      text,
      html,
    });
  }
}

export const emailService = new EmailService();
