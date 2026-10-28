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

export interface CaptainInjuryAlertEmailPayload {
  to: string;
  managerName?: string;
  captainName: string;
  squadId?: string;
  squadName?: string;
  playerId?: number;
  gameweekId?: number;
  gameweekName?: string;
  status: string;
  news?: string | null;
  chanceOfPlayingNextRound?: number | null;
  teamManagementUrl?: string;
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
  skipped?: boolean;
  reason?: string;
}

export interface EmailProvider {
  sendEmail(options: SendEmailOptions): Promise<EmailProviderResult>;
}

const STATUS_LABELS: Record<string, string> = {
  i: "Injured",
  d: "Doubtful",
  s: "Suspended",
  u: "Unavailable",
  a: "Available",
};

export function formatPlayerInjuryStatus(status: string): string {
  return STATUS_LABELS[status.toLowerCase()] ?? status.toUpperCase();
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
  /** Tracks `(gameweekId:recipientKey:playerKey:status)` so duplicate emails are not sent in the same gameweek. */
  private readonly sentCaptainAlerts = new Set<string>();
  private readonly queuedCaptainAlerts: CaptainInjuryAlertEmailPayload[] = [];

  constructor(private provider: EmailProvider = new ResendEmailProvider()) {}

  public getProvider(): EmailProvider {
    return this.provider;
  }

  public setProvider(provider: EmailProvider): void {
    this.provider = provider;
  }

  public resetCaptainAlertRateLimit(): void {
    this.sentCaptainAlerts.clear();
    this.queuedCaptainAlerts.length = 0;
  }

  public getQueuedCaptainAlerts(): CaptainInjuryAlertEmailPayload[] {
    return [...this.queuedCaptainAlerts];
  }

  public static buildCaptainAlertDedupeKey(payload: CaptainInjuryAlertEmailPayload): string {
    const gwKey = payload.gameweekId ?? payload.gameweekName ?? "current";
    const recipientKey = payload.squadId ?? payload.to.toLowerCase();
    const playerKey = payload.playerId ?? payload.captainName.toLowerCase();
    const statusKey = payload.status.toLowerCase();
    return `${gwKey}:${recipientKey}:${playerKey}:${statusKey}`;
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

  /**
   * Generates text and HTML email template alerting a manager that their squad captain
   * has been flagged as injured ('i'), doubtful ('d'), or suspended ('s') before the deadline.
   */
  public generateCaptainInjuryAlertTemplate(payload: CaptainInjuryAlertEmailPayload): {
    subject: string;
    text: string;
    html: string;
  } {
    const managerName = payload.managerName || "Manager";
    const statusLabel = formatPlayerInjuryStatus(payload.status);
    const newsDetail =
      payload.news && payload.news.trim().length > 0
        ? payload.news.trim()
        : `${payload.captainName} has been marked as ${statusLabel.toLowerCase()} ahead of the upcoming deadline.`;
    const baseUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
    const teamManagementUrl = payload.teamManagementUrl || `${baseUrl}/team`;
    const gwLabel = payload.gameweekName || (payload.gameweekId ? `Gameweek ${payload.gameweekId}` : "Upcoming Gameweek");
    const subject = `Captain Alert: ${payload.captainName} is ${statusLabel} (${gwLabel})`;

    const chanceLine =
      payload.chanceOfPlayingNextRound !== undefined && payload.chanceOfPlayingNextRound !== null
        ? `Chance of Playing: ${payload.chanceOfPlayingNextRound}%`
        : "";

    const text = [
      `Hello ${managerName},`,
      ``,
      `Heads up before the ${gwLabel} deadline! Your designated squad captain, ${payload.captainName}${payload.squadName ? ` (${payload.squadName})` : ""}, has had their status updated to ${statusLabel} (${payload.status}).`,
      ``,
      `Injury / Availability News: ${newsDetail}`,
      chanceLine,
      ``,
      `Update your captain or make transfers before the deadline here:`,
      `${teamManagementUrl}`,
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
    <h2 style="color: #f87171; margin-top: 0;">Captain Availability Alert ⚠️</h2>
    <p>Hello <strong>${managerName}</strong>,</p>
    <p>Your designated squad captain <strong>${payload.captainName}</strong>${payload.squadName ? ` in <strong>${payload.squadName}</strong>` : ""} has been flagged prior to the <strong>${gwLabel}</strong> deadline.</p>

    <div style="background-color: #0f172a; padding: 16px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #f87171;">
      <p style="margin: 4px 0;"><strong>Captain:</strong> ${payload.captainName}</p>
      <p style="margin: 4px 0;"><strong>Status:</strong> <span style="color: #f87171; font-weight: bold;">${statusLabel} (${payload.status})</span></p>
      <p style="margin: 4px 0;"><strong>News:</strong> ${newsDetail}</p>
      ${chanceLine ? `<p style="margin: 4px 0;"><strong>${chanceLine}</strong></p>` : ""}
    </div>

    <p style="margin: 24px 0;">
      <a href="${teamManagementUrl}" style="display: inline-block; background-color: #10b981; color: #0f172a; font-weight: bold; text-decoration: none; padding: 12px 20px; border-radius: 6px;">
        Manage Your Team
      </a>
    </p>

    <p style="font-size: 13px; color: #cbd5e1;">
      Direct link: <a href="${teamManagementUrl}" style="color: #38bdf8;">${teamManagementUrl}</a>
    </p>

    <hr style="border: 0; border-top: 1px solid #334155; margin: 24px 0;" />
    <p style="font-size: 12px; color: #94a3b8; text-align: center;">
      This is an automated squad alert from FantasyXI.
    </p>
  </div>
</body>
</html>
    `.trim();

    return { subject, text, html };
  }

  /**
   * Enqueues and dispatches a CaptainInjuryAlertEmail with per-gameweek rate limiting
   * so duplicate emails are not sent for the same injury in the same gameweek.
   */
  public async enqueueCaptainInjuryAlertEmail(
    payload: CaptainInjuryAlertEmailPayload
  ): Promise<EmailProviderResult> {
    const dedupeKey = EmailService.buildCaptainAlertDedupeKey(payload);
    if (this.sentCaptainAlerts.has(dedupeKey)) {
      return {
        success: true,
        skipped: true,
        reason: "DUPLICATE_GAMEWEEK_ALERT",
      };
    }

    this.sentCaptainAlerts.add(dedupeKey);
    this.queuedCaptainAlerts.push(payload);

    const { subject, text, html } = this.generateCaptainInjuryAlertTemplate(payload);
    return this.provider.sendEmail({
      to: payload.to,
      subject,
      text,
      html,
    });
  }

  public async sendCaptainInjuryAlert(
    payload: CaptainInjuryAlertEmailPayload
  ): Promise<EmailProviderResult> {
    return this.enqueueCaptainInjuryAlertEmail(payload);
  }
}

export const emailService = new EmailService();
