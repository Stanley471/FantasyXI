/**
 * Mailer abstraction (issue #117).
 *
 * Security alerts (new-device logins, failed-login spikes) need to reach a
 * user by email without the rest of the codebase, or its tests, depending on
 * live SMTP credentials. `Mailer` is the interface every caller depends on;
 * `ConsoleMailer` is a real, working implementation that logs the rendered
 * message (useful in local/dev environments and this sandbox, where no SMTP
 * relay is configured), and `NoOpMailer` is a test double that records sent
 * messages for assertions instead of doing any I/O.
 *
 * Wiring a real SMTP/API-based transport (SES, Postmark, SendGrid, etc.) later
 * only means adding another `Mailer` implementation - no caller changes.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Default mailer for environments without SMTP credentials configured.
 * Logs the message it would have sent; never throws, since a mailer failure
 * must never take down the request that triggered the alert.
 */
export class ConsoleMailer implements Mailer {
  public async send(message: EmailMessage): Promise<void> {
    console.log(
      `[mailer] To: ${message.to} | Subject: ${message.subject}\n${message.text}`
    );
  }
}

/** Test double: records every message instead of sending it. */
export class NoOpMailer implements Mailer {
  public readonly sent: EmailMessage[] = [];

  public async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * Selects the mailer implementation. Set `SMTP_HOST` (or any real transport's
 * config) once one is wired up; until then, alerts are logged via
 * `ConsoleMailer` rather than silently dropped.
 */
export function createDefaultMailer(): Mailer {
  return new ConsoleMailer();
}

export const mailer: Mailer = createDefaultMailer();
