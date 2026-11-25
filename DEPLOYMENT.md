# Deployment Guide

## Quick Start Without Dependencies

The FPL API Health Monitor is designed to work in environments where you may need to minimize dependencies. All core logic is self-contained and can be compiled to JavaScript.

## Build from Source (No Runtime Dependencies)

The TypeScript source code compiles to pure JavaScript. Once compiled, the service requires only Node.js built-in modules for core functionality.

### Compilation Steps

```bash
# 1. Ensure TypeScript is available (dev dependency only)
npx tsc

# 2. Review compiled output
ls -la dist/

# 3. Run with Node.js (no dependencies needed)
node dist/index.js
```

### Minimal Production Bundle

For production deployments with strict dependency requirements:

```bash
# Compile TypeScript
npx tsc

# Copy only dist and package.json
mkdir -p prod-bundle
cp -r dist prod-bundle/
cp package.json prod-bundle/

# Deploy prod-bundle/ to production
# Then run with Node.js directly
node dist/index.js
```

## Architecture Overview

### Core Components (No External Dependencies)

1. **types.ts** - TypeScript interfaces and enums
2. **logger.ts** - Logging system (uses Pino, but can be replaced)
3. **schema-validator.ts** - JSON schema validation
4. **circuit-breaker.ts** - Circuit breaker pattern implementation
5. **health-canary.ts** - Health monitoring and probing
6. **backup-scraper.ts** - Backup data source management
7. **notifier.ts** - Webhook notifications
8. **index.ts** - Service orchestration

### Dependency Graph

```
index.ts (Orchestrator)
├── health-canary.ts
│   ├── circuit-breaker.ts
│   ├── schema-validator.ts
│   └── logger.ts
├── backup-scraper.ts
│   └── logger.ts
├── notifier.ts
│   └── logger.ts
└── types.ts (Shared)
```

## Configuration Without .env

If you cannot use `.env` files, configure via environment variables directly:

```bash
# Set as environment variables
export FPL_API_BASE_URL="https://fantasy.premierleague.com/api"
export CANARY_PROBE_INTERVAL_MS="30000"
export CANARY_PROBE_TIMEOUT_MS="3000"
export BACKUP_API_URL="https://api.example.com/fpl-backup"
export FALLBACK_CACHE_PATH="/tmp/fpl-cache.json"
export LOG_LEVEL="info"
export NOTIFICATION_ENABLED="false"

# Run the service
node dist/index.js
```

## Running Without Package Manager

If npm is not available, you can manually manage the compiled output:

```bash
# 1. Get the TypeScript compiler (one-time setup)
# Download ts3.9 release or use pre-compiled tsc

# 2. Compile your files
tsc --lib es2020 --module commonjs --target es2020 \
    --outDir dist src/*.ts src/**/*.ts

# 3. Run with Node.js
node dist/index.js
```

## Docker Deployment

### Minimal Docker Image

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy only source and compiled output
COPY src ./src
COPY dist ./dist
COPY package.json .

# No npm install needed - just run
ENV NODE_ENV=production
ENV FPL_API_BASE_URL=https://fantasy.premierleague.com/api
ENV CANARY_PROBE_INTERVAL_MS=30000
ENV LOG_LEVEL=info

CMD ["node", "dist/index.js"]
```

Build and run:

```bash
docker build -t fpl-monitor .
docker run -e DISCORD_WEBHOOK_URL="$WEBHOOK_URL" fpl-monitor
```

## Cloud Deployment

### AWS Lambda

```typescript
// lambda-handler.ts
import { FPLHealthMonitor } from './dist/index';

let monitor: FPLHealthMonitor | null = null;

export async function handler() {
  if (!monitor) {
    monitor = new FPLHealthMonitor();
    monitor.start();
  }

  return monitor.getStatus();
}
```

Deploy as Lambda layer with Node.js 20 runtime.

### Google Cloud Run

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY dist ./dist
COPY package.json .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

```bash
gcloud run deploy fpl-monitor --source .
```

### Azure Container Instances

```bash
az container create \
  --resource-group mygroup \
  --name fpl-monitor \
  --image fpl-monitor:latest \
  --environment-variables \
    FPL_API_BASE_URL="https://fantasy.premierleague.com/api" \
    CANARY_PROBE_INTERVAL_MS="30000"
```

## Systemd Service (Linux)

Create `/etc/systemd/system/fpl-monitor.service`:

```ini
[Unit]
Description=FPL API Health Monitor
After=network.target

[Service]
Type=simple
User=fpl-monitor
WorkingDirectory=/opt/fpl-monitor
ExecStart=/usr/bin/node /opt/fpl-monitor/dist/index.js
Restart=always
RestartSec=10
Environment="NODE_ENV=production"
Environment="LOG_LEVEL=info"
Environment="FPL_API_BASE_URL=https://fantasy.premierleague.com/api"

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable fpl-monitor
sudo systemctl start fpl-monitor
sudo systemctl status fpl-monitor
```

## PM2 Process Manager

```bash
# Install PM2 (if available)
npm install -g pm2

# Start with PM2
pm2 start dist/index.js --name fpl-monitor

# Configure restart policy
pm2 save
pm2 startup
```

Or use `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'fpl-monitor',
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      FPL_API_BASE_URL: 'https://fantasy.premierleague.com/api'
    }
  }]
};
```

## Health Check Endpoints

The service logs health status every 60 seconds. Integrate with your monitoring:

```bash
# Check service is running
ps aux | grep "node dist/index.js"

# View logs
tail -f /var/log/fpl-monitor.log
```

## Monitoring Integration

### Datadog Logs

```typescript
// Logs automatically appear in Datadog
logger.info({ provider: currentProvider }, 'Health monitor status');
```

### New Relic

Wrap with New Relic agent:

```bash
# Add to start command
node -r newrelic dist/index.js
```

### Splunk

Forward logs to Splunk:

```bash
tail -f /var/log/fpl-monitor.log | \
  curl -k https://splunk-input.example.com:8088/services/collector \
    -H "Authorization: Splunk YOUR_TOKEN" \
    -d @-
```

## Scaling Considerations

### Horizontal Scaling

Each instance is independent and can run in parallel:

```bash
# Run multiple instances on different ports
PORT=3001 node dist/index.js &
PORT=3002 node dist/index.js &
PORT=3003 node dist/index.js &
```

### Shared Cache

For multiple instances, use shared cache location:

```env
FALLBACK_CACHE_PATH=/var/cache/fpl/shared-cache.json
```

Ensure file permissions allow read/write:

```bash
mkdir -p /var/cache/fpl
chmod 777 /var/cache/fpl
```

### Load Balancing

Use consistent hashing to distribute traffic:

```nginx
upstream fpl_monitors {
  hash $request_uri consistent;
  server 127.0.0.1:3001;
  server 127.0.0.1:3002;
  server 127.0.0.1:3003;
}

server {
  listen 80;
  location /api/fpl {
    proxy_pass http://fpl_monitors;
  }
}
```

## Troubleshooting Deployments

### Check Compilation

```bash
# Verify TypeScript compiles without errors
npx tsc --noEmit

# Check for type errors
npx tsc --strict --noEmit
```

### Verify Runtime

```bash
# Test the compiled code
node -e "require('./dist/index.js')"

# Check Node.js version compatibility
node --version  # Should be v14+
```

### Debug Startup Issues

```bash
# Run with verbose logging
LOG_LEVEL=debug node dist/index.js

# Enable Node.js debug mode
node --inspect dist/index.js
# Then connect with Chrome DevTools
```

### Monitor Resource Usage

```bash
# Check memory and CPU
top -p $(pgrep -f "node dist/index.js")

# Profile with Node.js
node --prof dist/index.js
node --prof-process isolate-*.log > profile.txt
```

## Rollback Strategy

Keep previous versions available:

```bash
# Before deploying new version
mv /opt/fpl-monitor/dist /opt/fpl-monitor/dist-v1

# Deploy new version
cp -r dist /opt/fpl-monitor/

# If issues, rollback
rm -rf /opt/fpl-monitor/dist
mv /opt/fpl-monitor/dist-v1 /opt/fpl-monitor/dist
systemctl restart fpl-monitor
```

## Disaster Recovery

### Backup Fallback Cache

```bash
# Daily backup of fallback cache
0 2 * * * cp /tmp/fpl-fallback-cache.json /backups/fpl-cache-$(date +%Y%m%d).json
```

### Restore from Backup

```bash
# If cache corrupted
cp /backups/fpl-cache-latest.json /tmp/fpl-fallback-cache.json
systemctl restart fpl-monitor
```

## Performance Tuning

### Memory Usage

Typical memory footprint: 50-100MB

If memory constrained:
- Reduce degradation indicator history (default 50)
- Reduce response time history (default 100)
- Increase garbage collection frequency

### CPU Usage

Typical CPU usage: <1% (mostly idle between probes)

If CPU high:
- Increase probe interval (default 30s)
- Check for notification delivery issues
- Monitor circuit breaker thrashing

## Security Considerations

### Webhook URLs

Store webhook URLs securely:

```bash
# Use environment variables or secrets manager
export DISCORD_WEBHOOK_URL="$(aws secretsmanager get-secret-value --secret-id fpl/discord-webhook)"

# Never commit to version control
echo ".env" >> .gitignore
```

### API Rate Limiting

Respect FPL API rate limits:
- Default probe interval: 30 seconds
- Backup API should have own rate limiting
- Monitor 429 responses

### Logging Sensitive Data

Never log webhook URLs or secrets:

```typescript
// ✓ Good
logger.info({ provider: 'BACKUP' }, 'Switched to backup');

// ✗ Bad
logger.info({ webhook: process.env.DISCORD_WEBHOOK_URL });
```

## Next Steps

1. Compile TypeScript: `npx tsc`
2. Test with Node.js: `node dist/index.js`
3. Choose deployment platform
4. Configure health monitoring
5. Set up log aggregation
6. Deploy to production
