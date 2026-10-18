import { EmailService, emailService } from "../email/emailService.js";

/**
 * Operational alerts for platform administrators (dropped transactions,
 * ledger reconciliation discrepancies).
 *
 * Channels are configured through the environment and are all optional:
 *   ADMIN_ALERT_SLACK_WEBHOOK_URL  Slack incoming-webhook URL
 *   ADMIN_ALERT_EMAILS             comma-separated recipient list
 *
 * `notify()` never throws: an alert that cannot be delivered is logged so the
 * job that raised it (a poller, a reconciliation run) keeps going.
 */

export type AdminAlertSeverity = "info" | "warning" | "critical";

export interface AdminAlert {
  title: string;
  severity: AdminAlertSeverity;
  /** Plain-text body (also used for Slack) */
  text: string;
  /** Optional HTML body for email; defaults to the escaped text */
  html?: string;
}

export interface AdminAlertResult {
  slack: "sent" | "failed" | "skipped";
  email: { sent: number; failed: number };
}

export interface AdminAlertSink {
  notify(alert: AdminAlert): Promise<AdminAlertResult>;
}

export interface AdminAlertNotifierOptions {
  slackWebhookUrl?: string;
  emailRecipients?: string[];
  email?: EmailService;
  httpFetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class AdminAlertNotifier implements AdminAlertSink {
  private readonly options: AdminAlertNotifierOptions;

  constructor(options: AdminAlertNotifierOptions = {}) {
    this.options = options;
  }

  // Read lazily: dotenv may load after this module is first imported
  private get slackWebhookUrl(): string | undefined {
    return this.options.slackWebhookUrl ?? (process.env.ADMIN_ALERT_SLACK_WEBHOOK_URL || undefined);
  }

  private get emailRecipients(): string[] {
    if (this.options.emailRecipients) return this.options.emailRecipients;
    return (process.env.ADMIN_ALERT_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);
  }

  public async notify(alert: AdminAlert): Promise<AdminAlertResult> {
    const result: AdminAlertResult = { slack: "skipped", email: { sent: 0, failed: 0 } };
    const subject = `[FantasyXI ${alert.severity.toUpperCase()}] ${alert.title}`;

    const slackUrl = this.slackWebhookUrl;
    if (slackUrl) {
      result.slack = await this.postToSlack(slackUrl, `*${subject}*\n${alert.text}`);
    }

    const recipients = this.emailRecipients;
    if (recipients.length > 0) {
      const email = this.options.email ?? emailService;
      const html = alert.html ?? `<pre style="font-family: monospace">${escapeHtml(alert.text)}</pre>`;
      for (const to of recipients) {
        try {
          const sent = await email.getProvider().sendEmail({ to, subject, text: alert.text, html });
          if (sent.success) result.email.sent++;
          else result.email.failed++;
        } catch (error) {
          result.email.failed++;
          console.error(`[admin-alert] Email to ${to} failed:`, (error as Error).message);
        }
      }
    }

    if (result.slack === "skipped" && recipients.length === 0) {
      console.warn(`[admin-alert] No alert channel configured. ${subject}\n${alert.text}`);
    }
    return result;
  }

  private async postToSlack(url: string, text: string): Promise<"sent" | "failed"> {
    const httpFetch = this.options.httpFetch ?? (globalThis.fetch as typeof fetch);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
    try {
      const response = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        console.error(`[admin-alert] Slack webhook returned HTTP ${response.status}`);
        return "failed";
      }
      return "sent";
    } catch (error) {
      console.error("[admin-alert] Slack webhook failed:", (error as Error).message);
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }
}

export const adminAlertNotifier = new AdminAlertNotifier();
