import axios from 'axios';
import { logger } from './logger';
import { FailoverEvent, CanaryMetrics, CircuitBreakerStatus } from './types';

/**
 * Notification service for failover and recovery events
 * Sends alerts to Discord and/or Slack webhooks
 */
export class Notifier {
  private discordWebhookUrl?: string;
  private slackWebhookUrl?: string;
  private notificationEnabled: boolean;

  constructor(
    discordWebhookUrl?: string,
    slackWebhookUrl?: string,
    notificationEnabled: boolean = true
  ) {
    this.discordWebhookUrl = discordWebhookUrl;
    this.slackWebhookUrl = slackWebhookUrl;
    this.notificationEnabled = notificationEnabled;

    if (notificationEnabled && !discordWebhookUrl && !slackWebhookUrl) {
      logger.warn('Notifications enabled but no webhook URLs configured');
    }

    if (notificationEnabled) {
      logger.info(
        { hasDiscord: !!discordWebhookUrl, hasSlack: !!slackWebhookUrl },
        'Notifier initialized'
      );
    }
  }

  /**
   * Send failover/recovery notification
   */
  public async notify(event: FailoverEvent, metrics?: CanaryMetrics, cbStatus?: CircuitBreakerStatus): Promise<void> {
    if (!this.notificationEnabled) {
      return;
    }

    const timestamp = new Date(event.timestamp).toISOString();
    const isFailover = event.type === 'FAILOVER';

    const message = {
      title: isFailover ? '🚨 FPL API Failover' : '✅ FPL API Recovered',
      color: isFailover ? 'ff0000' : '00ff00',
      reason: event.reason || 'Unknown reason',
      from: event.fromProvider,
      to: event.toProvider,
      timestamp,
      metrics: metrics ? this.formatMetrics(metrics) : undefined,
      cbStatus: cbStatus ? this.formatCBStatus(cbStatus) : undefined,
    };

    const promises = [];

    if (this.discordWebhookUrl) {
      promises.push(this.sendDiscordNotification(message).catch((err) => {
        logger.error({ err }, 'Failed to send Discord notification');
      }));
    }

    if (this.slackWebhookUrl) {
      promises.push(this.sendSlackNotification(message).catch((err) => {
        logger.error({ err }, 'Failed to send Slack notification');
      }));
    }

    await Promise.all(promises);
  }

  /**
   * Send Discord webhook notification
   */
  private async sendDiscordNotification(message: {
    title: string;
    color: string;
    reason: string;
    from: string;
    to: string;
    timestamp: string;
    metrics?: object;
    cbStatus?: object;
  }): Promise<void> {
    if (!this.discordWebhookUrl) {
      return;
    }

    const colorHex = parseInt(message.color, 16);

    const discordMessage = {
      embeds: [
        {
          title: message.title,
          color: colorHex,
          fields: [
            {
              name: 'Provider Transition',
              value: `${message.from} → ${message.to}`,
              inline: false,
            },
            {
              name: 'Reason',
              value: message.reason,
              inline: false,
            },
            {
              name: 'Timestamp',
              value: message.timestamp,
              inline: false,
            },
            ...(message.metrics
              ? [
                  {
                    name: 'Metrics',
                    value: `\`\`\`json\n${JSON.stringify(message.metrics, null, 2)}\n\`\`\``,
                    inline: false,
                  },
                ]
              : []),
            ...(message.cbStatus
              ? [
                  {
                    name: 'Circuit Breaker Status',
                    value: `\`\`\`json\n${JSON.stringify(message.cbStatus, null, 2)}\n\`\`\``,
                    inline: false,
                  },
                ]
              : []),
          ],
        },
      ],
    };

    await axios.post(this.discordWebhookUrl, discordMessage);
    logger.debug('Discord notification sent');
  }

  /**
   * Send Slack webhook notification
   */
  private async sendSlackNotification(message: {
    title: string;
    color: string;
    reason: string;
    from: string;
    to: string;
    timestamp: string;
    metrics?: object;
    cbStatus?: object;
  }): Promise<void> {
    if (!this.slackWebhookUrl) {
      return;
    }

    const slackMessage = {
      attachments: [
        {
          title: message.title,
          color: message.color,
          fields: [
            {
              title: 'Provider Transition',
              value: `${message.from} → ${message.to}`,
              short: false,
            },
            {
              title: 'Reason',
              value: message.reason,
              short: false,
            },
            {
              title: 'Timestamp',
              value: message.timestamp,
              short: false,
            },
            ...(message.metrics
              ? [
                  {
                    title: 'Metrics',
                    value: `\`\`\`${JSON.stringify(message.metrics, null, 2)}\`\`\``,
                    short: false,
                  },
                ]
              : []),
            ...(message.cbStatus
              ? [
                  {
                    title: 'Circuit Breaker Status',
                    value: `\`\`\`${JSON.stringify(message.cbStatus, null, 2)}\`\`\``,
                    short: false,
                  },
                ]
              : []),
          ],
        },
      ],
    };

    await axios.post(this.slackWebhookUrl, slackMessage);
    logger.debug('Slack notification sent');
  }

  /**
   * Format metrics for display
   */
  private formatMetrics(metrics: CanaryMetrics): object {
    return {
      probesExecuted: metrics.probesExecuted,
      probesSucceeded: metrics.probesSucceeded,
      probesFailed: metrics.probesFailed,
      successRate: `${((metrics.probesSucceeded / metrics.probesExecuted) * 100).toFixed(2)}%`,
      averageResponseTimeMs: metrics.averageResponseTimeMs.toFixed(2),
      currentProvider: metrics.currentProvider,
      degradationIndicators: metrics.degradationIndicators.length,
    };
  }

  /**
   * Format circuit breaker status for display
   */
  private formatCBStatus(status: CircuitBreakerStatus): object {
    return {
      state: status.state,
      failureCount: status.failureCount,
      successCount: status.successCount,
      transitionTime: new Date(status.transitionTime).toISOString(),
      lastError: status.lastError,
    };
  }
}
