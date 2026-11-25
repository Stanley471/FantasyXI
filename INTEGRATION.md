# Integration Guide

This document explains how to integrate the FPL API Health Monitor with your existing data pipeline.

## Quick Start

### 1. Initialize the Monitor

```typescript
import { FPLHealthMonitor } from './src/index';

const monitor = new FPLHealthMonitor();
monitor.start();
```

### 2. Get Data with Automatic Failover

```typescript
// In your data fetching pipeline
const data = await monitor.fetchBootstrapData();

// data will come from:
// 1. Primary FPL API (if healthy)
// 2. Backup API (if primary down)
// 3. Local cache (if backup down)
// 4. Emergency fallback (if all else fails)
```

### 3. Monitor Service Health

```typescript
// Get current status anytime
const status = monitor.getStatus();

if (status.currentProvider === 'PRIMARY') {
  console.log('Using primary FPL API');
} else {
  console.log(`Using ${status.currentProvider} - primary API degraded`);
  console.log('Degradation indicators:', status.canary.metrics.degradationIndicators);
}
```

## Integration with Existing Data Pipeline

### Express.js Example

```typescript
import express from 'express';
import { FPLHealthMonitor } from './src/index';

const app = express();
const monitor = new FPLHealthMonitor();
monitor.start();

// Health check endpoint
app.get('/health/monitor', (req, res) => {
  const status = monitor.getStatus();
  res.json(status);
});

// Existing endpoint with automatic fallback
app.get('/api/fpl/bootstrap', async (req, res) => {
  try {
    const data = await monitor.fetchBootstrapData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Unable to fetch FPL data' });
  }
});

app.listen(3000);
```

### GraphQL Integration

```typescript
import { GraphQLSchema, GraphQLObjectType, GraphQLField } from 'graphql';

const query = new GraphQLObjectType({
  name: 'Query',
  fields: {
    fplBootstrap: {
      type: BootstrapType,
      resolve: async () => {
        return await monitor.fetchBootstrapData();
      },
    },
    healthStatus: {
      type: HealthStatusType,
      resolve: () => {
        return monitor.getStatus();
      },
    },
  },
});
```

### Event-Driven Integration

```typescript
// Subscribe to failover events
monitor.canary.onFailoverListener(async (event) => {
  // Publish event to event bus
  await eventBus.publish('fpl:failover', {
    type: event.type,
    from: event.fromProvider,
    to: event.toProvider,
    timestamp: event.timestamp,
  });

  // Update feature flags
  await featureFlags.set('use_fpl_primary', event.toProvider === 'PRIMARY');

  // Log to analytics
  analytics.track('fpl_failover', {
    reason: event.reason,
    provider: event.toProvider,
  });
});
```

## Backup Data Source Setup

### Configure Secondary API Provider

Set up a secondary API provider (e.g., RapidAPI FPL, alternative sports data platform):

```env
BACKUP_API_URL=https://api.rapidapi.com/fpl/bootstrap

# Or your own mirror:
BACKUP_API_URL=https://your-fpl-mirror.com/api
```

### Configure Fallback Cache

The fallback cache stores the last successful response:

```env
FALLBACK_CACHE_PATH=/var/cache/fpl/bootstrap-static.json
```

The cache is automatically updated whenever:
1. Primary API succeeds
2. Backup API succeeds

Cache loading order:
1. Try fallback cache (checked on startup)
2. Emergency fallback if cache missing or corrupted

### Database Snapshot Strategy

For maximum resilience, maintain a database snapshot:

```typescript
// Periodically snapshot current data to database
async function snapshotFPLData() {
  const data = await monitor.fetchBootstrapData();

  await db.fplSnapshots.create({
    timestamp: new Date(),
    data: data,
    source: monitor.currentProvider,
  });

  // Keep last 10 snapshots
  const snapshots = await db.fplSnapshots
    .find({})
    .sort({ timestamp: -1 })
    .limit(10);

  if (snapshots.length > 10) {
    const toDelete = snapshots.slice(10);
    await db.fplSnapshots.deleteMany({ _id: { $in: toDelete.map(s => s._id) } });
  }
}

// Run every 5 minutes
setInterval(snapshotFPLData, 5 * 60 * 1000);
```

## Notification Integration

### Discord Setup

1. Create a Discord server and channel
2. Get webhook URL:
   - Server Settings → Integrations → Webhooks → New Webhook
   - Copy webhook URL

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

### Slack Setup

1. Create a Slack app
2. Add Incoming Webhooks
3. Copy webhook URL

```env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
```

### Custom Notification Handler

```typescript
monitor.canary.onFailoverListener(async (event) => {
  // Send custom notification
  await customNotificationService.send({
    channel: 'fpl-alerts',
    severity: event.type === 'FAILOVER' ? 'critical' : 'info',
    title: `FPL API ${event.type}`,
    message: `Switched from ${event.fromProvider} to ${event.toProvider}: ${event.reason}`,
  });
});
```

## Monitoring and Alerting

### Prometheus Metrics

```typescript
import prometheus from 'prom-client';

const probeSuccessRate = new prometheus.Gauge({
  name: 'fpl_probe_success_rate',
  help: 'FPL API probe success rate',
});

const currentProvider = new prometheus.Gauge({
  name: 'fpl_current_provider',
  help: 'Current FPL data provider (1=PRIMARY, 2=BACKUP, 3=FALLBACK)',
});

// Update metrics
setInterval(() => {
  const metrics = monitor.getMetrics();
  const rate = (metrics.probesSucceeded / metrics.probesExecuted) * 100;
  probeSuccessRate.set(rate);

  const providerMap = { PRIMARY: 1, BACKUP: 2, FALLBACK: 3 };
  currentProvider.set(providerMap[metrics.currentProvider] || 0);
}, 60000);
```

### DataDog Integration

```typescript
import StatsD from 'node-statsd';

const client = new StatsD();

monitor.canary.onFailoverListener(async (event) => {
  client.gauge('fpl.failover.count', 1);
  client.event('FPL Failover', {
    text: `Switched to ${event.toProvider}`,
    alert_type: event.type === 'FAILOVER' ? 'error' : 'success',
    tags: [`provider:${event.toProvider}`, `reason:${event.reason}`],
  });
});
```

## Testing Integration

### Unit Test with Mock Monitor

```typescript
jest.mock('./src/index');

test('handles failover gracefully', async () => {
  const mockMonitor = {
    currentProvider: 'BACKUP',
    fetchBootstrapData: jest.fn().mockResolvedValue({ /* mock data */ }),
    getStatus: jest.fn(),
  };

  const data = await mockMonitor.fetchBootstrapData();
  expect(data).toBeDefined();
});
```

### Integration Test with Real Service

```typescript
import { FPLHealthMonitor } from './src/index';

describe('Integration: FPL Data Pipeline', () => {
  let monitor: FPLHealthMonitor;

  beforeAll(() => {
    monitor = new FPLHealthMonitor();
    monitor.start();
  });

  afterAll(() => {
    monitor.canary.stop();
  });

  it('provides data from primary or backup', async () => {
    const data = await monitor.fetchBootstrapData();
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('teams');
  });

  it('reports health status', () => {
    const status = monitor.getStatus();
    expect(['PRIMARY', 'BACKUP', 'FALLBACK']).toContain(status.currentProvider);
  });
});
```

## Deployment Considerations

### Docker

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

ENV NODE_ENV=production
ENV LOG_LEVEL=info

CMD ["node", "dist/index.js"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fpl-health-monitor
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fpl-health-monitor
  template:
    metadata:
      labels:
        app: fpl-health-monitor
    spec:
      containers:
      - name: monitor
        image: your-registry/fpl-health-monitor:latest
        env:
        - name: FPL_API_BASE_URL
          value: "https://fantasy.premierleague.com/api"
        - name: LOG_LEVEL
          value: "info"
        - name: DISCORD_WEBHOOK_URL
          valueFrom:
            secretKeyRef:
              name: fpl-secrets
              key: discord-webhook
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
```

### Environment-Specific Configuration

```bash
# Development
cp .env.example .env
source .env
npm run dev

# Production
source .env.production
npm start

# Staging with verbose logging
LOG_LEVEL=debug npm start
```

## Troubleshooting

### Monitor not detecting failures

1. Check probe interval: `CANARY_PROBE_INTERVAL_MS`
2. Verify endpoint accessibility
3. Check network connectivity
4. Review logs: `LOG_LEVEL=debug`

### Notifications not sending

1. Verify webhook URLs in environment
2. Check Discord/Slack permissions
3. Monitor network requests: enable verbose logging
4. Test webhook manually: `curl -X POST $WEBHOOK_URL -d '{"content":"test"}'`

### Fallback cache not updating

1. Check cache directory permissions
2. Verify `FALLBACK_CACHE_PATH` is writable
3. Ensure backup API is accessible
4. Check disk space availability

### Circuit breaker stuck in OPEN state

1. Verify primary API is actually healthy
2. Check `CANARY_CONSECUTIVE_HEALTHY_FOR_RECOVERY` threshold
3. Manually reset: `circuitBreaker.reset()`
4. Review degradation indicators for ongoing issues

## Performance Tuning

### Reduce Probe Frequency (less aggressive)

```env
CANARY_PROBE_INTERVAL_MS=60000  # 60 seconds instead of 30
```

### Increase Timeout Threshold (for slower networks)

```env
CANARY_PROBE_TIMEOUT_MS=5000    # 5 seconds instead of 3
```

### Adjust Recovery Threshold (faster recovery)

```env
CANARY_CONSECUTIVE_HEALTHY_FOR_RECOVERY=3  # 90 seconds instead of 150
```

## Next Steps

1. Set up backup API provider
2. Configure notification webhooks
3. Run chaos tests in staging environment
4. Deploy to production with monitoring
5. Monitor failover events and performance metrics
6. Iterate on thresholds based on real-world data
