# Quick Start Guide

## 5-Minute Setup

### 1. Environment Setup

```bash
# Copy example config
cp .env.example .env

# Edit .env with your values
# Minimum required:
# - FPL_API_BASE_URL (already set)
# - BACKUP_API_URL (set to your backup provider)
# - FALLBACK_CACHE_PATH (already set)
```

### 2. Compile TypeScript

```bash
npx tsc
```

Output appears in `dist/` directory.

### 3. Run the Service

```bash
# Start monitoring
node dist/index.js

# Or with environment variables
FPL_API_BASE_URL="https://fantasy.premierleague.com/api" \
CANARY_PROBE_INTERVAL_MS="30000" \
node dist/index.js
```

### 4. Integrate with Your Code

```typescript
import { FPLHealthMonitor } from './dist/index.js';

const monitor = new FPLHealthMonitor();
monitor.start();

// Get data with automatic failover
const data = await monitor.fetchBootstrapData();
console.log('Using provider:', monitor.getStatus().currentProvider);
```

## Common Tasks

### Check Service Status

```typescript
const status = monitor.getStatus();
console.log(status.currentProvider); // PRIMARY, BACKUP, or FALLBACK
console.log(status.canary.metrics.averageResponseTimeMs);
console.log(status.canary.circuitBreaker.state);
```

### Listen for Failovers

```typescript
monitor.canary.onFailoverListener(async (event) => {
  console.log(`Failed over from ${event.fromProvider} to ${event.toProvider}`);
  console.log(`Reason: ${event.reason}`);
  
  // Send alert, update metrics, etc.
  await sendAlert(event);
});
```

### Configure Notifications

Set in `.env`:

```env
NOTIFICATION_ENABLED=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
```

Automatically sends notifications on failover/recovery.

### Run Tests

```bash
# All tests
npm test

# Chaos tests only
npm run test:chaos

# Specific test file
npm test -- schema-validator
```

### Type Check Without Compiling

```bash
npx tsc --noEmit
```

## Configuration Quick Reference

| Setting | Default | Purpose |
|---------|---------|---------|
| `FPL_API_BASE_URL` | `https://fantasy.premierleague.com/api` | Primary API endpoint |
| `CANARY_PROBE_INTERVAL_MS` | `30000` | Health check every 30s |
| `CANARY_PROBE_TIMEOUT_MS` | `3000` | Timeout after 3s |
| `CANARY_HEALTH_CHECK_THRESHOLD_MS` | `3000` | Flag response >3s |
| `CANARY_CONSECUTIVE_HEALTHY_FOR_RECOVERY` | `5` | Need 5 min healthy to recover |
| `BACKUP_API_URL` | (required) | Secondary provider |
| `FALLBACK_CACHE_PATH` | `/tmp/fpl-fallback-cache.json` | Cache location |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NOTIFICATION_ENABLED` | `true` | Enable webhook notifications |

## Troubleshooting

### Service won't start

```bash
# Check Node.js version
node --version  # Should be v14+

# Check for compilation errors
npx tsc --noEmit

# Run with debug logging
LOG_LEVEL=debug node dist/index.js
```

### Primary API not failing over

```bash
# Check if circuit breaker is open
const status = monitor.getStatus();
console.log(status.canary.circuitBreaker.state); // Should be OPEN

# Check degradation indicators
console.log(status.canary.metrics.degradationIndicators);

# Manually trigger failover for testing
monitor.canary.circuitBreaker.testRecovery();
```

### Notifications not sending

```bash
# Verify webhook URL
echo $DISCORD_WEBHOOK_URL

# Check Discord/Slack permissions
# Test webhook manually:
curl -X POST $DISCORD_WEBHOOK_URL \
  -H "Content-Type: application/json" \
  -d '{"content":"test"}'

# Enable debug logging
LOG_LEVEL=debug node dist/index.js
```

### Cache not updating

```bash
# Verify cache path is writable
touch /tmp/fpl-fallback-cache.json

# Check file permissions
ls -la /tmp/fpl-fallback-cache.json

# Ensure backup API is accessible
curl https://your-backup-api.com/bootstrap-static/
```

## Development Workflow

### Watch Mode

```bash
# Recompile on file changes
npx tsc --watch
```

In another terminal:

```bash
# Restart service on changes
nodemon dist/index.js
```

### Adding Features

1. Define types in `src/types.ts`
2. Implement logic in appropriate component
3. Add tests to `src/__tests__/`
4. Compile: `npx tsc`
5. Test: `npm test`

### Debugging

```bash
# Node inspector
node --inspect dist/index.js

# Chrome DevTools
# Visit: chrome://inspect

# Direct logging
const { logger } = require('./dist/logger');
logger.debug({ data }, 'Debug message');
```

## Performance Tips

### Reduce Memory Usage

```env
# Decrease history sizes (in health-canary.ts)
# Change: this.responseTimeHistory.splice(0, 100)
# To: this.responseTimeHistory.splice(0, 50)

# Fewer degradation indicators
# Change: this.degradationIndicators.splice(0, 50)
# To: this.degradationIndicators.splice(0, 25)
```

### Reduce CPU Usage

```env
# Increase probe interval (less frequent checks)
CANARY_PROBE_INTERVAL_MS=60000  # 60 seconds

# Increase health threshold
CANARY_HEALTH_CHECK_THRESHOLD_MS=5000  # 5 seconds
```

### Reduce Disk I/O

```env
# Disable cache updates (backup API only)
# Or increase cache update interval

# Move cache to RAM disk (Linux)
FALLBACK_CACHE_PATH=/mnt/ramdisk/fpl-cache.json
```

## Deployment Checklist

- [ ] Compile TypeScript: `npx tsc`
- [ ] Run tests: `npm test`
- [ ] Configure `.env` for production
- [ ] Set up backup API provider
- [ ] Configure Discord/Slack webhooks
- [ ] Set up log aggregation
- [ ] Test in staging environment
- [ ] Monitor initial rollout
- [ ] Set up alerting on failovers

## Next Steps

1. **Read Architecture**: See `ARCHITECTURE.md` for design details
2. **Read API Reference**: See `API.md` for complete API documentation
3. **Read Integration Guide**: See `INTEGRATION.md` for real-world integration patterns
4. **Run Tests**: `npm run test:chaos` to verify failover behavior
5. **Deploy**: Follow `DEPLOYMENT.md` for production rollout

## Support

For issues or questions:

1. Check logs: `tail -f app.log`
2. Review recent degradation indicators
3. Check circuit breaker state
4. Verify backup API accessibility
5. Test with chaos tests: `npm run test:chaos`

## Key Concepts

**Circuit Breaker**: 
- CLOSED = Primary API healthy
- OPEN = Primary degraded, using backup
- HALF_OPEN = Testing recovery

**Failover**: Automatic switch to backup when primary fails

**Recovery**: Automatic switch back to primary after stable period

**Health Probe**: Request to primary API every 30s to check health

**Degradation Indicator**: Signal that primary API is failing (429, timeout, schema change, 502, etc.)

---

For detailed documentation, see:
- `README.md` - Overview and features
- `ARCHITECTURE.md` - System design
- `API.md` - API reference
- `INTEGRATION.md` - Integration patterns
- `DEPLOYMENT.md` - Deployment guide
