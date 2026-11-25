# FPL API Health Monitor & Backup Scraper

An intelligent health monitoring and backup scraper service that detects FPL API degradation and seamlessly switches to backup data sources during live matchdays.

## Features

- **30-second Health Probing**: Continuous monitoring of FPL API endpoints
- **Multi-indicator Degradation Detection**:
  - HTTP 429 (Rate limiting)
  - Response timeouts (> 3000ms)
  - JSON schema validation failures
  - HTTP 502 (Bad Gateway) errors
- **Circuit Breaker Pattern**: Graceful failover to backup providers
- **Multi-tier Fallback Strategy**:
  1. Secondary API provider
  2. Local filesystem cache
  3. Emergency fallback with static data
- **Automatic Recovery**: Validates primary health for 5 consecutive minutes before switching back
- **Admin Notifications**: Discord and Slack webhook integration for failover/recovery events
- **Comprehensive Chaos Testing**: Simulates real-world degradation scenarios

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                                                           │
│  Health Canary Service                                   │
│  ├─ Probes primary FPL API every 30s                    │
│  ├─ Validates response schema                            │
│  └─ Tracks degradation indicators                        │
│                                                           │
└─────────────────────────────────────────────────────────┘
                          │
                    (Healthy?)
                      /     \
                    Yes      No
                    │         │
        ┌───────────┘         └──────────────┐
        │                                     │
        v                                     v
   PRIMARY API                          Circuit Breaker
   (Pass through)                        (Opens - Failover)
                                              │
                                              v
                                    Backup Scraper
                                    ├─ Try secondary API
                                    ├─ Try local cache
                                    └─ Emergency fallback
                                              │
                                              v
                                    Notifier Service
                                    (Discord/Slack)
```

## Installation

```bash
npm install
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and update values:

```bash
cp .env.example .env
```

Key configuration options:

```env
# FPL API
FPL_API_BASE_URL=https://fantasy.premierleague.com/api
FPL_BOOTSTRAP_ENDPOINT=/bootstrap-static/

# Canary Configuration
CANARY_PROBE_INTERVAL_MS=30000              # Probe every 30 seconds
CANARY_PROBE_TIMEOUT_MS=3000                # Timeout after 3 seconds
CANARY_HEALTH_CHECK_THRESHOLD_MS=3000       # Flag slow responses
CANARY_CONSECUTIVE_HEALTHY_FOR_RECOVERY=5   # Need 5 min of health to recover

# Backup & Fallback
BACKUP_API_URL=https://api.example.com/fpl-backup
FALLBACK_CACHE_PATH=/tmp/fpl-fallback-cache.json

# Notifications
NOTIFICATION_ENABLED=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Logging
LOG_LEVEL=info              # debug, info, warn, error
LOG_FORMAT=pretty           # pretty or json
```

## Usage

### Start the Service

```bash
npm start
```

### Development Mode

```bash
npm run dev
```

### Run Tests

```bash
npm test
```

### Run Chaos Tests

```bash
npm run test:chaos
```

## How It Works

### 1. Health Probing

The canary service makes HTTP requests to the FPL API every 30 seconds:

```typescript
// Automatic probing
canary.start();

// Manual check
const metrics = canary.getMetrics();
```

### 2. Degradation Detection

Detects multiple failure modes:

```typescript
// Rate limiting
if (response.status === 429) {
  indicator = 'RATE_LIMIT'
}

// Timeout
if (responseTimeMs > 3000) {
  indicator = 'TIMEOUT'
}

// Schema validation
if (!validateFPLSchema(data)) {
  indicator = 'SCHEMA_CHANGE'
}

// HTTP errors
if (response.status >= 500) {
  indicator = 'HTTP_ERROR'
}
```

### 3. Circuit Breaker State Machine

```
CLOSED (Healthy)
   ├─ After 3 failures → OPEN
   │
OPEN (Degraded)
   ├─ After 2x probe interval → test recovery → HALF_OPEN
   │
HALF_OPEN (Testing)
   ├─ If success → CLOSED
   └─ If failure → back to OPEN
```

### 4. Failover Strategy

```typescript
// When circuit opens, backup scraper activates
try {
  // Try secondary API provider
  data = await backupScraper.fetchFromBackupAPI(endpoint);
} catch {
  try {
    // Fall back to local cache
    data = await backupScraper.fetchFromFallbackCache();
  } catch {
    // Emergency fallback with minimal but valid data
    data = getEmergencyFallbackData();
  }
}
```

### 5. Notifications

On failover or recovery:

```json
{
  "type": "FAILOVER",
  "fromProvider": "PRIMARY",
  "toProvider": "BACKUP",
  "reason": "Rate limit detected (HTTP 429)",
  "metrics": {
    "probesExecuted": 42,
    "probesSucceeded": 30,
    "successRate": "71.43%",
    "avgResponseTime": "1250.5ms"
  },
  "circuitBreaker": {
    "state": "OPEN",
    "failureCount": 3,
    "successCount": 0
  }
}
```

## API Reference

### HealthCanary

```typescript
// Start monitoring
canary.start();

// Get current metrics
const metrics = canary.getMetrics();
// {
//   probesExecuted: number
//   probesSucceeded: number
//   probesFailed: number
//   averageResponseTimeMs: number
//   currentProvider: 'PRIMARY' | 'BACKUP' | 'FALLBACK'
//   degradationIndicators: DegradationIndicator[]
// }

// Check if primary is healthy
const isHealthy = canary.isPrimaryHealthy();

// Get circuit breaker status
const cbStatus = canary.getCircuitBreakerStatus();
// {
//   state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
//   failureCount: number
//   successCount: number
//   lastError?: string
// }

// Stop monitoring
canary.stop();
```

### BackupScraper

```typescript
// Fetch from backup API
const data = await backupScraper.fetchFromBackupAPI('/bootstrap-static/');

// Get available backup data (tries API then cache)
const data = await backupScraper.getAvailableBackupData(endpoint);

// Get cache status
const status = backupScraper.getCacheStatus();
// {
//   hasCachedData: boolean
//   cacheAgeMins: number | null
//   cachePath: string
// }
```

### Notifier

```typescript
// Send failover notification
await notifier.notify(failoverEvent, metrics, circuitBreakerStatus);
```

## Chaos Testing

The service includes comprehensive chaos tests that simulate real-world failure scenarios:

### Test Scenarios

1. **Rate Limiting (HTTP 429)**: Detects API rate limiting
2. **Latency Spikes**: Response times exceeding threshold
3. **Bad Gateway (HTTP 502)**: Server errors with recovery
4. **Schema Validation**: Malformed payload detection
5. **Connection Timeouts**: Network timeouts
6. **Flaky Service**: Intermittent failures
7. **60-second Failover Requirement**: Validates acceptance criteria
8. **Data Continuity**: Ensures no data truncation during failover

Run chaos tests:

```bash
npm run test:chaos
```

Example output:

```
PASS  src/__tests__/chaos.test.ts
  Chaos Tests - FPL API Degradation Scenarios
    Scenario 1: Rate Limiting Detection
      ✓ should detect rate limiting and failover within 60 seconds
    Scenario 2: Latency Spike Detection
      ✓ should detect response time exceeding threshold
    Scenario 3: Bad Gateway Recovery
      ✓ should failover on 502 and recover when primary healthy
    ...
```

## Acceptance Criteria Status

- [x] **Canary Detection (60s)**: Detects upstream outage within 60 seconds and flips circuit breaker
- [x] **Data Continuity**: Live scoring pipeline continues with backup feed without truncation
- [x] **Admin Notifications**: Discord/Slack webhooks on failover and recovery
- [x] **Chaos Testing**: Simulates latency spikes, 502 errors, and schema changes

## Monitoring and Observability

### Log Levels

```bash
LOG_LEVEL=debug  # Detailed probe information
LOG_LEVEL=info   # Key events and transitions
LOG_LEVEL=warn   # Degradation indicators
LOG_LEVEL=error  # Failures and critical issues
```

### Metrics to Track

- Probe success rate
- Average response time
- Failover frequency
- Time to recover
- Backup data freshness
- Circuit breaker state transitions

### Health Check Endpoint

The service exposes a status endpoint for monitoring:

```typescript
const status = monitor.getStatus();
// {
//   service: 'FPL Health Monitor',
//   status: 'running',
//   currentProvider: 'PRIMARY' | 'BACKUP',
//   canary: { metrics, circuitBreaker },
//   backup: { cache },
//   timestamp: ISO string
// }
```

## Performance Considerations

- Probes run every 30 seconds (configurable)
- Response timeout set to 3 seconds
- Health check threshold at 3 seconds
- Maximum 100 recent response times stored in memory
- Maximum 50 recent degradation indicators stored
- Fallback cache persisted to disk

## Error Handling

The service implements defensive programming:

- Probe failures don't crash the service
- Fallback cache loads gracefully
- Notification failures logged but non-blocking
- Missing environment variables use sensible defaults
- Circuit breaker prevents cascading failures

## Contributing

When adding new degradation indicators or backup sources:

1. Add new indicator type to `DegradationIndicator` in `types.ts`
2. Implement detection logic in `HealthCanary`
3. Add test cases to `chaos.test.ts`
4. Update documentation

## License

This project is licensed under the **MIT License**. See the `LICENSE` file for details.

## Stellar Testnet Setup

For a full walkthrough of the contract architecture, local and Testnet setup, building and testing, and the client-side signing flow, see the [Stellar and Soroban Development and Testing Guide](docs/STELLAR_SOROBAN_GUIDE.md).

This section helps contributors configure the Stellar Testnet environment locally to interact with Soroban contracts and the USDC Stellar Asset used by FantasyXI.

- **Network & endpoints**:
   - Horizon: `https://horizon-testnet.stellar.org`
   - Soroban RPC: `https://soroban-testnet.stellar.org`
   - Network passphrase: `Test SDF Network ; September 2015`

- **Required environment variables** (add these to `backend/.env` and `frontend/.env.local` as appropriate):
   - `STELLAR_NETWORK` (e.g. `TESTNET`)
   - `STELLAR_HORIZON_URL` (e.g. `https://horizon-testnet.stellar.org`)
   - `STELLAR_SOROBAN_RPC_URL` (e.g. `https://soroban-testnet.stellar.org`)
   - `STELLAR_NETWORK_PASSPHRASE` (e.g. `Test SDF Network ; September 2015`)
   - `STELLAR_USDC_ASSET_CODE` (e.g. `USDC`)
   - `STELLAR_USDC_ISSUER` (classic issuer public key, e.g. `GC43IGCUMQYECKMRKGSJE2RPQPJ2QNHFB6VAHNNBO4NONKK3PVHEXN25`)
   - `STELLAR_USDC_TOKEN_CONTRACT_ID` (SAC contract id, e.g. `CBKWOGJ7CQSVZXIOIIPCDAUT6APQYBCEE7QTSGDZZ2RO6D3JYRMKWZNG`)
   - `STELLAR_ESCROW_CONTRACT_ID` (Escrow contract id, e.g. `CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA`)

- **Creating & funding testnet accounts**:
   1. Generate a new keypair using the Stellar Laboratory or the SDK of your choice.
       - Stellar Laboratory Keypair tool: https://laboratory.stellar.org/#account-creator?network=test
   2. Fund your testnet account using Friendbot:
       - Friendbot URL: `https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY`
       - Example: `curl "https://friendbot.stellar.org/?addr=G...YOUR_PUBLIC...KEY"`

- **Obtaining testnet USDC**:
   - On Testnet, USDC is represented by a token issuer and/or SAC contract. If the repo provides a test USDC faucet script, run it; otherwise request USDC by contacting the test asset issuer or minting via a local/authorized issuer key (not in production).
   - Helpful links:
      - Stellar Laboratory (Transactions & Assets): https://laboratory.stellar.org/
      - Horizon Testnet Explorer: https://stellar.expert/explorer/testnet

- **Trustline note**: Before receiving USDC or interacting with the USDC SAC, ensure your test account establishes a trustline to the USDC asset (unless using contract-controlled flows that don't require a classic trustline). In the Stellar Laboratory, add an Asset with code `USDC` and issuer `GC43IGCUMQYECKMRKGSJE2RPQPJ2QNHFB6VAHNNBO4NONKK3PVHEXN25` and submit a change-trust operation.

- **Quick example: fund + trustline via `stellar-sdk` (Node.js)**
```js
// install: npm install stellar-sdk
const StellarSdk = require('stellar-sdk');
const server = new StellarSdk.Server('https://horizon-testnet.stellar.org');
const pair = StellarSdk.Keypair.random();
console.log('Public:', pair.publicKey());
console.log('Secret:', pair.secret());
// Fund using Friendbot (curl in shell) then create trustline and optionally request test USDC from issuer-owned faucet.
```

If you follow the steps above you will be able to fund a testnet account and configure your local environment to interact with the Soroban RPC and the FantasyXI escrow contract on Stellar Testnet.
