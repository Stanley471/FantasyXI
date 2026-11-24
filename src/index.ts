import dotenv from 'dotenv';
import { logger } from './logger';
import { HealthCanary } from './health-canary';
import { BackupScraper } from './backup-scraper';
import { Notifier } from './notifier';
import { DataProvider, FailoverEvent } from './types';

// Load environment variables
dotenv.config();

/**
 * FPL API Health Monitor and Backup Scraper Service
 *
 * Orchestrates:
 * 1. Continuous health monitoring of primary FPL API
 * 2. Seamless failover to backup sources on degradation
 * 3. Automatic recovery when primary is stable again
 * 4. Admin notifications via Discord/Slack webhooks
 */
class FPLHealthMonitor {
  private canary: HealthCanary;
  private backupScraper: BackupScraper;
  private notifier: Notifier;

  private currentProvider: DataProvider = 'PRIMARY';
  private lastFailoverTime: number = 0;
  private failoverCooldownMs: number = 60000; // 1 minute between notifications

  constructor() {
    const fplBaseUrl = process.env.FPL_API_BASE_URL || 'https://fantasy.premierleague.com/api';
    const probeIntervalMs = parseInt(process.env.CANARY_PROBE_INTERVAL_MS || '30000', 10);
    const probeTimeoutMs = parseInt(process.env.CANARY_PROBE_TIMEOUT_MS || '3000', 10);
    const healthCheckThresholdMs = parseInt(process.env.CANARY_HEALTH_CHECK_THRESHOLD_MS || '3000', 10);
    const recoveryThreshold = parseInt(process.env.CANARY_CONSECUTIVE_HEALTHY_FOR_RECOVERY || '5', 10);

    const backupApiUrl = process.env.BACKUP_API_URL || 'https://api.example.com/fpl-backup';
    const fallbackCachePath = process.env.FALLBACK_CACHE_PATH || '/tmp/fpl-fallback-cache.json';

    const notificationEnabled = process.env.NOTIFICATION_ENABLED !== 'false';
    const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    // Initialize services
    this.canary = new HealthCanary(
      fplBaseUrl,
      probeIntervalMs,
      probeTimeoutMs,
      healthCheckThresholdMs,
      recoveryThreshold
    );

    this.backupScraper = new BackupScraper(backupApiUrl, fallbackCachePath);

    this.notifier = new Notifier(discordWebhookUrl, slackWebhookUrl, notificationEnabled);

    // Wire up event handlers
    this.canary.onFailoverListener(this.handleFailover.bind(this));

    logger.info('FPL Health Monitor initialized');
  }

  /**
   * Start the health monitoring service
   */
  public start(): void {
    logger.info('Starting FPL Health Monitor');
    this.canary.start();

    // Log health status periodically
    const statusIntervalId = setInterval(() => {
      const metrics = this.canary.getMetrics();
      const cbStatus = this.canary.getCircuitBreakerStatus();

      logger.info(
        {
          provider: this.currentProvider,
          cbState: cbStatus.state,
          successRate: `${((metrics.probesSucceeded / metrics.probesExecuted) * 100).toFixed(2)}%`,
          avgResponseTime: `${metrics.averageResponseTimeMs.toFixed(0)}ms`,
          degradationIndicators: metrics.degradationIndicators.length,
        },
        'Health monitor status'
      );
    }, 60000); // Every minute

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully');
      clearInterval(statusIntervalId);
      this.canary.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      clearInterval(statusIntervalId);
      this.canary.stop();
      process.exit(0);
    });
  }

  /**
   * Handle failover events from circuit breaker
   */
  private async handleFailover(event: FailoverEvent): Promise<void> {
    this.currentProvider = event.toProvider;

    const timeSinceLastFailover = Date.now() - this.lastFailoverTime;
    const shouldNotify = timeSinceLastFailover > this.failoverCooldownMs;

    logger.info(
      {
        event,
        shouldNotify,
        timeSinceLastFailover,
      },
      'Failover event received'
    );

    if (shouldNotify) {
      const metrics = this.canary.getMetrics();
      const cbStatus = this.canary.getCircuitBreakerStatus();

      await this.notifier.notify(event, metrics, cbStatus);
      this.lastFailoverTime = Date.now();
    }
  }

  /**
   * Get current service status
   */
  public getStatus() {
    const canaryMetrics = this.canary.getMetrics();
    const cbStatus = this.canary.getCircuitBreakerStatus();
    const cacheStatus = this.backupScraper.getCacheStatus();

    return {
      service: 'FPL Health Monitor',
      status: 'running',
      currentProvider: this.currentProvider,
      canary: {
        metrics: canaryMetrics,
        circuitBreaker: cbStatus,
      },
      backup: {
        cache: cacheStatus,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Fetch data using current provider (primary or backup)
   */
  public async fetchBootstrapData(): Promise<unknown> {
    const endpoint = process.env.FPL_BOOTSTRAP_ENDPOINT || '/bootstrap-static/';

    try {
      if (this.canary.isPrimaryHealthy()) {
        logger.debug('Fetching from primary API');
        // This would normally be handled by your existing data pipeline
        return { source: 'PRIMARY', message: 'Primary API data would be fetched here' };
      }
    } catch (error) {
      logger.error({ error }, 'Primary API fetch failed');
    }

    // Fall back to backup sources
    logger.info('Fetching from backup sources');
    return this.backupScraper.getAvailableBackupData(endpoint);
  }
}

// Start the service if running as main module
if (require.main === module) {
  const monitor = new FPLHealthMonitor();
  monitor.start();

  // Expose status endpoint for monitoring
  console.log('FPL Health Monitor is running. Status:', monitor.getStatus());
}

export { FPLHealthMonitor };
