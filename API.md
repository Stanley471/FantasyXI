# API Reference

## Core Service

### FPLHealthMonitor

Main service orchestrator that coordinates all components.

#### Constructor

```typescript
new FPLHealthMonitor()
```

Initializes all services based on environment configuration.

#### Methods

##### `start()`

Start the health monitoring service.

```typescript
monitor.start();
```

- Begins periodic health probes every 30 seconds
- Starts recovery testing when circuit is open
- Logs status every 60 seconds
- Sets up signal handlers for graceful shutdown

##### `stop()`

Stop the health monitoring service.

```typescript
monitor.stop();
```

Cleanly shuts down all probes and intervals.

##### `getStatus()`

Get comprehensive service status.

```typescript
const status = monitor.getStatus();
// Returns:
{
  service: 'FPL Health Monitor',
  status: 'running',
  currentProvider: 'PRIMARY' | 'BACKUP' | 'FALLBACK',
  canary: {
    metrics: CanaryMetrics,
    circuitBreaker: CircuitBreakerStatus
  },
  backup: {
    cache: CacheStatus
  },
  timestamp: '2024-01-01T12:00:00Z'
}
```

##### `fetchBootstrapData()`

Fetch FPL bootstrap data from primary or backup source.

```typescript
const data = await monitor.fetchBootstrapData();
// Returns FPL API response or fallback data
```

This is the main method for integrating with your data pipeline. It:
1. Checks if primary is healthy
2. Falls back to backup sources if needed
3. Never throws (always returns usable data)
4. Uses emergency fallback as last resort

---

## Health Canary Service

### HealthCanary

Continuous health monitoring and degradation detection.

#### Constructor

```typescript
new HealthCanary(
  baseUrl: string,
  probeIntervalMs?: number,      // default: 30000
  probeTimeoutMs?: number,       // default: 3000
  healthCheckThresholdMs?: number, // default: 3000
  recoveryThresholdProbes?: number // default: 5
)
```

#### Methods

##### `start()`

Begin periodic health probes.

```typescript
canary.start();
```

Starts probing every `probeIntervalMs` milliseconds.

##### `stop()`

Stop periodic health probes.

```typescript
canary.stop();
```

##### `getMetrics()`

Get current health metrics.

```typescript
const metrics = canary.getMetrics();
// Returns CanaryMetrics:
{
  probesExecuted: number,
  probesSucceeded: number,
  probesFailed: number,
  averageResponseTimeMs: number,
  lastProbeTime: number,
  currentProvider: 'PRIMARY' | 'BACKUP' | 'FALLBACK',
  degradationIndicators: DegradationIndicator[]
}
```

##### `getCircuitBreakerStatus()`

Get circuit breaker state information.

```typescript
const status = canary.getCircuitBreakerStatus();
// Returns CircuitBreakerStatus:
{
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN',
  transitionTime: number,
  failureCount: number,
  successCount: number,
  lastError?: string
}
```

##### `isPrimaryHealthy()`

Quick check if primary API is healthy.

```typescript
if (canary.isPrimaryHealthy()) {
  // Use primary API
} else {
  // Use backup sources
}
```

Returns `true` if circuit breaker is closed.

##### `getCurrentProvider()`

Get the current data provider in use.

```typescript
const provider = canary.getCurrentProvider();
// Returns: 'PRIMARY' | 'BACKUP' | 'FALLBACK'
```

##### `onFailoverListener(callback)`

Register callback for failover/recovery events.

```typescript
canary.onFailoverListener(async (event: FailoverEvent) => {
  console.log(`Failover: ${event.fromProvider} → ${event.toProvider}`);
  console.log(`Reason: ${event.reason}`);
  // Handle failover...
});
```

---

## Circuit Breaker

### CircuitBreaker

State machine for managing failover decisions.

#### Constructor

```typescript
new CircuitBreaker(recoveryThreshold?: number)
// default recovery threshold: 5 consecutive successes
```

#### Methods

##### `recordSuccess()`

Record a successful health probe.

```typescript
circuitBreaker.recordSuccess();
```

- In CLOSED state: no action
- In HALF_OPEN state: increments success counter
- Triggers recovery when threshold reached

##### `recordFailure(error: string)`

Record a failed health probe.

```typescript
circuitBreaker.recordFailure('HTTP 429: Rate limited');
```

- In CLOSED state: increments failure counter
- Triggers failover when threshold reached
- In HALF_OPEN state: resets to OPEN

##### `testRecovery()`

Attempt to test recovery from OPEN state.

```typescript
circuitBreaker.testRecovery();
```

Transitions from OPEN to HALF_OPEN for testing.

##### `getState()`

Get current circuit breaker state.

```typescript
const state = circuitBreaker.getState();
// Returns: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
```

##### `getStatus()`

Get detailed status information.

```typescript
const status = circuitBreaker.getStatus();
// Returns CircuitBreakerStatus
```

##### `isOpen()`

Check if circuit is open (should use backup).

```typescript
if (circuitBreaker.isOpen()) {
  // Use backup sources
}
```

Returns true for OPEN or HALF_OPEN states.

##### `isHalfOpen()`

Check if currently testing recovery.

```typescript
if (circuitBreaker.isHalfOpen()) {
  // This probe result is critical for recovery decision
}
```

##### `reset()`

Manually reset circuit breaker to CLOSED state.

```typescript
circuitBreaker.reset();
```

Use with caution - only when you're sure the issue is resolved.

##### `onStateChangeListener(callback)`

Register callback for state transitions.

```typescript
circuitBreaker.onStateChangeListener(async (event: FailoverEvent) => {
  console.log(`State changed: ${event.type}`);
  // Send notifications...
});
```

---

## Backup Scraper

### BackupScraper

Manage fallback data sources.

#### Constructor

```typescript
new BackupScraper(
  backupApiUrl: string,
  fallbackCachePath: string,
  backupTimeoutMs?: number  // default: 5000
)
```

#### Methods

##### `fetchFromBackupAPI(endpoint: string)`

Fetch from secondary API provider.

```typescript
const data = await backupScraper.fetchFromBackupAPI('/bootstrap-static/');
```

- Attempts to reach backup API
- Auto-updates local cache on success
- Throws on failure

##### `fetchFromFallbackCache()`

Fetch from local filesystem cache.

```typescript
const data = await backupScraper.fetchFromFallbackCache();
```

- Returns last known good data
- Returns null if cache doesn't exist
- Logs cache age

##### `getAvailableBackupData(endpoint: string)`

Get backup data from any available source.

```typescript
const data = await backupScraper.getAvailableBackupData('/bootstrap-static/');
```

Tries in order:
1. Backup API
2. Local cache
3. Emergency fallback

Never throws - always returns usable data.

##### `getCacheStatus()`

Get cache metadata.

```typescript
const status = backupScraper.getCacheStatus();
// Returns:
{
  hasCachedData: boolean,
  cacheAgeMins: number | null,
  cachePath: string
}
```

---

## Schema Validator

### Exported Functions

#### `validateFPLSchema(data: unknown): SchemaValidationResult`

Validate FPL API response against expected schema.

```typescript
const result = validateFPLSchema(response.data);

if (!result.isValid) {
  console.log('Missing fields:', result.missingFields);
  console.log('Type errors:', result.typeErrors);
}
```

Returns:
```typescript
{
  isValid: boolean,
  missingFields?: string[],
  extraFields?: string[],
  typeErrors?: Record<string, string>
}
```

#### `isSignificantSchemaChange(result: SchemaValidationResult): boolean`

Determine if validation failure indicates a significant change.

```typescript
if (isSignificantSchemaChange(validationResult)) {
  // This is worth triggering failover
  circuitBreaker.recordFailure('Significant schema change');
}
```

---

## Notifier Service

### Notifier

Send notifications via webhooks.

#### Constructor

```typescript
new Notifier(
  discordWebhookUrl?: string,
  slackWebhookUrl?: string,
  notificationEnabled?: boolean
)
```

#### Methods

##### `notify(event: FailoverEvent, metrics?: CanaryMetrics, cbStatus?: CircuitBreakerStatus)`

Send failover/recovery notification.

```typescript
await notifier.notify(failoverEvent, canaryMetrics, circuitBreakerStatus);
```

Sends to configured Discord/Slack webhooks with:
- Event type and details
- Reason for failover/recovery
- Current metrics
- Circuit breaker status

---

## Type Definitions

### FailoverEvent

```typescript
interface FailoverEvent {
  type: 'FAILOVER' | 'RECOVERY';
  fromProvider: 'PRIMARY' | 'BACKUP' | 'FALLBACK';
  toProvider: 'PRIMARY' | 'BACKUP' | 'FALLBACK';
  reason?: string;
  timestamp: number;
  metrics?: CanaryMetrics;
}
```

### CanaryMetrics

```typescript
interface CanaryMetrics {
  probesExecuted: number;
  probesSucceeded: number;
  probesFailed: number;
  averageResponseTimeMs: number;
  lastProbeTime: number;
  currentProvider: 'PRIMARY' | 'BACKUP' | 'FALLBACK';
  degradationIndicators: DegradationIndicator[];
}
```

### CircuitBreakerStatus

```typescript
interface CircuitBreakerStatus {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  transitionTime: number;
  failureCount: number;
  successCount: number;
  lastError?: string;
}
```

### DegradationIndicator

```typescript
interface DegradationIndicator {
  type: 'RATE_LIMIT' | 'TIMEOUT' | 'SCHEMA_CHANGE' | 'HTTP_ERROR';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  message: string;
  timestamp: number;
}
```

### HealthCheckResult

```typescript
interface HealthCheckResult {
  timestamp: number;
  statusCode: number;
  responseTimeMs: number;
  isHealthy: boolean;
  error?: string;
  schemaValid: boolean;
}
```

---

## Usage Examples

### Basic Integration

```typescript
import { FPLHealthMonitor } from './src/index';

// Initialize
const monitor = new FPLHealthMonitor();
monitor.start();

// Fetch data
const data = await monitor.fetchBootstrapData();
console.log('Using provider:', monitor.getStatus().currentProvider);

// Check health
const status = monitor.getStatus();
if (status.canary.circuitBreaker.state === 'OPEN') {
  console.log('Primary API degraded, using backup');
}
```

### Express.js Endpoint

```typescript
app.get('/api/fpl/bootstrap', async (req, res) => {
  try {
    const data = await monitor.fetchBootstrapData();
    res.json({
      data,
      provider: monitor.getStatus().currentProvider
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to fetch FPL data' });
  }
});
```

### Custom Notification Handler

```typescript
monitor.canary.onFailoverListener(async (event) => {
  if (event.type === 'FAILOVER') {
    // Send PagerDuty alert
    await pagerduty.createIncident({
      title: 'FPL API Degradation Detected',
      description: event.reason,
      urgency: 'high'
    });
  }

  // Update feature flags
  const enabled = event.toProvider === 'PRIMARY';
  await featureFlags.set('use_fpl_primary', enabled);
});
```

### Metrics Export

```typescript
setInterval(() => {
  const status = monitor.getStatus();
  const metrics = status.canary.metrics;

  prometheus.register.getSingleMetricAsString('fpl_success_rate').then(value => {
    const rate = (metrics.probesSucceeded / metrics.probesExecuted) * 100;
    console.log(`FPL Success Rate: ${rate.toFixed(2)}%`);
    console.log(`Current Provider: ${metrics.currentProvider}`);
    console.log(`Avg Response: ${metrics.averageResponseTimeMs.toFixed(0)}ms`);
  });
}, 60000);
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  monitor.canary.stop();
  // Close database connections, etc.
  process.exit(0);
});
```

---

## Error Handling

All methods implement defensive error handling:

```typescript
// Safe - never throws
const data = await monitor.fetchBootstrapData();

// Safe - returns false if not healthy
const isHealthy = monitor.canary.isPrimaryHealthy();

// Safe - returns status even if error
const status = monitor.getStatus();
```

For error tracking:

```typescript
const cbStatus = monitor.canary.getCircuitBreakerStatus();
if (cbStatus.lastError) {
  console.error('Last error:', cbStatus.lastError);
}

const metrics = monitor.canary.getMetrics();
console.log('Recent degradation:',
  metrics.degradationIndicators.slice(-5)
);
```

---

## Configuration Environment Variables

```env
# FPL API Configuration
FPL_API_BASE_URL=https://fantasy.premierleague.com/api
FPL_BOOTSTRAP_ENDPOINT=/bootstrap-static/

# Canary Configuration
CANARY_PROBE_INTERVAL_MS=30000
CANARY_PROBE_TIMEOUT_MS=3000
CANARY_HEALTH_CHECK_THRESHOLD_MS=3000
CANARY_CONSECUTIVE_HEALTHY_FOR_RECOVERY=5

# Backup Data Sources
BACKUP_API_URL=https://api.example.com/fpl-backup
FALLBACK_CACHE_PATH=/tmp/fpl-fallback-cache.json

# Notification Configuration
NOTIFICATION_ENABLED=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Logging
LOG_LEVEL=info
LOG_FORMAT=pretty
```

---

## Best Practices

1. **Always use `fetchBootstrapData()`**: Let the service handle failover
2. **Monitor provider changes**: Listen to failover events
3. **Log status periodically**: Track service health
4. **Implement circuit breaker pattern**: Don't hammer degraded APIs
5. **Cache results locally**: Reduce dependency on upstream
6. **Test failover scenarios**: Use chaos tests in staging
7. **Set up notifications**: Know when failover happens
8. **Tune thresholds**: Adjust based on your use case
