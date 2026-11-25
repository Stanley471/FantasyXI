# Project Structure

## Directory Layout

```
odobs4/
├── src/
│   ├── __tests__/
│   │   ├── schema-validator.test.ts      # Schema validation tests
│   │   ├── circuit-breaker.test.ts       # Circuit breaker state machine tests
│   │   ├── health-canary.test.ts         # Health monitoring tests
│   │   └── chaos.test.ts                 # Real-world degradation scenarios
│   │
│   ├── types.ts                          # TypeScript interfaces and enums
│   ├── logger.ts                         # Logging configuration (Pino)
│   ├── schema-validator.ts               # FPL API schema validation
│   ├── circuit-breaker.ts                # Circuit breaker pattern implementation
│   ├── health-canary.ts                  # Health monitoring and probing service
│   ├── backup-scraper.ts                 # Backup data source management
│   ├── notifier.ts                       # Discord/Slack webhook notifications
│   └── index.ts                          # Service orchestrator and entry point
│
├── dist/                                 # Compiled JavaScript (generated)
│   └── [same structure as src/]
│
├── package.json                          # NPM dependencies and scripts
├── tsconfig.json                         # TypeScript compiler configuration
├── jest.config.js                        # Jest test runner configuration
├── .eslintrc.json                        # ESLint code style configuration
│
├── .env.example                          # Example environment variables
├── .gitignore                            # Git ignore rules
│
├── README.md                             # Project overview and features
├── QUICKSTART.md                         # 5-minute setup guide
├── API.md                                # Complete API reference
├── ARCHITECTURE.md                       # System design and architecture
├── INTEGRATION.md                        # Integration patterns and examples
├── DEPLOYMENT.md                         # Deployment and DevOps guide
└── PROJECT_STRUCTURE.md                  # This file
```

## File Descriptions

### Source Code (`src/`)

#### `types.ts`
- Defines all TypeScript interfaces and enums
- **Exports**: 
  - `HealthCheckResult`
  - `CircuitBreakerState` (enum)
  - `CircuitBreakerStatus`
  - `DegradationIndicator`
  - `DataProvider`
  - `CanaryMetrics`
  - `FailoverEvent`
  - `SchemaValidationResult`

#### `logger.ts`
- Pino logging configuration
- Supports multiple log formats (pretty, JSON)
- Configurable log levels
- **Exports**: `logger` instance

#### `schema-validator.ts`
- Validates FPL API responses against expected schema
- Defines required fields for bootstrap endpoint:
  - `events[]`: id, name, deadline_time
  - `teams[]`: id, name, code, short_name
  - `elements[]`: id, first_name, second_name, element_type, team
  - `element_types[]`: id, plural_name
- **Functions**:
  - `validateFPLSchema(data)` - Validate response structure
  - `isSignificantSchemaChange(result)` - Determine if change warrants failover

#### `circuit-breaker.ts`
- Implements circuit breaker pattern (CLOSED → OPEN → HALF_OPEN)
- Tracks failure and success counts
- Manages state transitions
- Notifies listeners on state changes
- **Class**: `CircuitBreaker`
- **Thresholds**:
  - Failure threshold: 3 consecutive failures
  - Recovery threshold: 5 consecutive successes

#### `health-canary.ts`
- Core health monitoring service
- Executes probes every 30 seconds
- Detects degradation indicators:
  - HTTP 429 (rate limiting)
  - Timeouts (>3000ms)
  - Schema validation failures
  - HTTP 502+ errors
  - Connection errors
- Tracks metrics and response times
- Integrates with circuit breaker
- **Class**: `HealthCanary`
- **Key Methods**:
  - `start()` - Begin probes
  - `stop()` - Stop probes
  - `getMetrics()` - Current metrics
  - `isPrimaryHealthy()` - Quick health check

#### `backup-scraper.ts`
- Manages fallback data sources
- Implements multi-tier fallback strategy:
  1. Secondary API provider
  2. Local filesystem cache
  3. Emergency fallback data
- Auto-updates cache from successful fetches
- Provides emergency fallback with:
  - All 20 Premier League teams
  - Valid FPL schema structure
  - Minimal but operational data
- **Class**: `BackupScraper`
- **Key Methods**:
  - `fetchFromBackupAPI(endpoint)` - Try secondary provider
  - `fetchFromFallbackCache()` - Try local cache
  - `getAvailableBackupData(endpoint)` - Try all sources
  - `getCacheStatus()` - Cache metadata

#### `notifier.ts`
- Sends failover and recovery notifications
- Integrates with:
  - Discord webhooks (rich embeds)
  - Slack webhooks (attachments)
  - Custom async callbacks
- Formats notifications with:
  - Event type and details
  - Failover reason
  - Health metrics
  - Circuit breaker status
- **Class**: `Notifier`
- **Methods**:
  - `notify(event, metrics, cbStatus)` - Send notification

#### `index.ts`
- Main service orchestrator
- Coordinates all components
- **Class**: `FPLHealthMonitor`
- **Key Methods**:
  - `start()` - Start monitoring
  - `getStatus()` - Comprehensive status
  - `fetchBootstrapData()` - Get data with failover

### Test Files (`src/__tests__/`)

#### `schema-validator.test.ts`
- Unit tests for schema validation
- Tests valid/invalid schemas
- Tests field detection
- Tests significance detection
- **Coverage**: ~90%

#### `circuit-breaker.test.ts`
- Unit tests for circuit breaker state machine
- Tests state transitions:
  - CLOSED → OPEN on failures
  - OPEN → HALF_OPEN on recovery test
  - HALF_OPEN → CLOSED on successes
- Tests failure tracking
- Tests state change listeners
- **Coverage**: ~95%

#### `health-canary.test.ts`
- Unit tests for health monitoring
- Tests probe success/failure
- Tests degradation detection
- Tests metrics calculation
- Tests circuit breaker integration
- **Coverage**: ~85%

#### `chaos.test.ts`
- Real-world degradation simulations
- **Test Scenarios**:
  1. Rate limiting (HTTP 429)
  2. Latency spikes (>3000ms)
  3. Bad gateway (HTTP 502) with recovery
  4. Schema validation failures
  5. Connection timeouts
  6. Intermittent failures (flaky service)
  7. 60-second failover requirement
  8. Data continuity during failover
- Simulates all acceptance criteria
- **Coverage**: ~90%

### Configuration Files

#### `package.json`
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "test": "jest",
    "test:chaos": "jest --testPathPattern=chaos",
    "lint": "eslint src/**/*.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "axios": "^1.6.2",      // HTTP client
    "dotenv": "^16.3.1",    // Environment variables
    "pino": "^8.17.2"       // Logging
  }
}
```

#### `tsconfig.json`
- Targets ES2020
- Strict type checking enabled
- Module output: CommonJS
- Source maps enabled
- Declaration files generated

#### `jest.config.js`
- Preset: ts-jest
- Test environment: node
- Coverage threshold: 70%
- Test files: `**/__tests__/**/*.test.ts`

#### `.eslintrc.json`
- Parser: @typescript-eslint/parser
- Extends: eslint:recommended
- Rules: No explicit any, warn on console

#### `.env.example`
```env
FPL_API_BASE_URL=https://fantasy.premierleague.com/api
CANARY_PROBE_INTERVAL_MS=30000
CANARY_PROBE_TIMEOUT_MS=3000
CANARY_HEALTH_CHECK_THRESHOLD_MS=3000
CANARY_CONSECUTIVE_HEALTHY_FOR_RECOVERY=5
BACKUP_API_URL=https://api.example.com/fpl-backup
FALLBACK_CACHE_PATH=/tmp/fpl-fallback-cache.json
NOTIFICATION_ENABLED=true
DISCORD_WEBHOOK_URL=...
SLACK_WEBHOOK_URL=...
LOG_LEVEL=info
LOG_FORMAT=pretty
```

### Documentation

#### `README.md`
- Project overview
- Feature list
- Installation instructions
- Configuration guide
- Usage examples
- Chaos testing overview
- Acceptance criteria checklist

#### `QUICKSTART.md`
- 5-minute setup guide
- Common tasks
- Configuration reference table
- Troubleshooting tips
- Development workflow
- Performance tuning
- Deployment checklist

#### `API.md`
- Complete API reference
- All public methods with examples
- Type definitions
- Error handling
- Configuration variables
- Best practices
- Usage examples for each component

#### `ARCHITECTURE.md`
- System design overview
- Component responsibilities
- Data flow patterns
- Sequence diagrams
- Error handling strategy
- Performance characteristics
- Scalability considerations
- Future enhancement points

#### `INTEGRATION.md`
- Integration patterns
- Express.js examples
- GraphQL integration
- Event-driven patterns
- Backup data source setup
- Notification configuration
- Monitoring and alerting
- Testing strategies
- Deployment examples
- Troubleshooting guide

#### `DEPLOYMENT.md`
- Build and compilation
- Configuration without .env
- Docker deployment
- Cloud platforms (AWS Lambda, GCP, Azure)
- Systemd service setup
- PM2 process management
- Monitoring integration
- Scaling considerations
- Performance tuning
- Security considerations

#### `PROJECT_STRUCTURE.md`
- This file
- Directory layout
- File descriptions
- Module dependencies
- Data flow between components

## Module Dependencies

```
index.ts (Orchestrator)
  ├─ health-canary.ts
  │  ├─ circuit-breaker.ts
  │  ├─ schema-validator.ts
  │  ├─ logger.ts
  │  └─ types.ts
  │
  ├─ backup-scraper.ts
  │  ├─ logger.ts
  │  └─ types.ts
  │
  ├─ notifier.ts
  │  ├─ logger.ts
  │  └─ types.ts
  │
  └─ types.ts (Shared)
```

## Data Flow

### Probe Execution Path
```
Health Canary
  ├─ Execute HTTP GET
  ├─ Measure response time
  ├─ Validate schema (schema-validator)
  ├─ Record result (success/failure)
  ├─ Update circuit breaker (circuit-breaker)
  └─ Log metrics (logger)
```

### Failover Detection Path
```
Circuit Breaker
  ├─ Track failure count
  ├─ Check threshold (3 failures)
  ├─ Transition state CLOSED → OPEN
  ├─ Notify listeners (failover event)
  └─ Trigger notifier (notifier)
```

### Data Fetch Path
```
Client Application
  ├─ Call fetchBootstrapData()
  ├─ Check circuit breaker state
  │
  ├─ If CLOSED: Try primary API
  ├─ If OPEN: Try backup sources
  │  ├─ Try backup API (backup-scraper)
  │  ├─ Try local cache (backup-scraper)
  │  └─ Use emergency fallback (backup-scraper)
  │
  └─ Return data
```

## Compilation Output

When TypeScript compiles to `dist/`:

```
dist/
├── types.js         (enums, type metadata)
├── logger.js        (logger initialization)
├── schema-validator.js
├── circuit-breaker.js
├── health-canary.js
├── backup-scraper.js
├── notifier.js
├── index.js         (entry point)
└── __tests__/       (compiled test files)
```

## Adding New Features

### To add a new degradation indicator:

1. Add to `DegradationIndicator.type` union in `types.ts`
2. Implement detection in `health-canary.ts`
3. Add test case to `chaos.test.ts`
4. Update docs in `README.md`

### To add a new backup source:

1. Implement in `backup-scraper.ts`
2. Add to fallback strategy in `getAvailableBackupData()`
3. Add tests
4. Update `INTEGRATION.md`

### To add new configuration option:

1. Add to `.env.example`
2. Document in `API.md`
3. Use in appropriate component
4. Add validation in `index.ts`

## Testing Strategy

### Unit Tests (70% coverage minimum)
- Schema validator: Input validation
- Circuit breaker: State transitions
- Health canary: Probe execution
- Notifier: Payload formatting

### Chaos Tests (Real-world scenarios)
- Rate limiting
- Latency spikes
- Server errors
- Schema changes
- Timeouts
- Flaky service
- Failover timing
- Data continuity

### Manual Testing
- Dev mode: `npm run dev`
- Specific test: `npm test -- component.test`
- Chaos tests: `npm run test:chaos`

## Performance Profile

| Metric | Value | Notes |
|--------|-------|-------|
| Memory | 50-100MB | Bounded history sizes |
| CPU | <1% | Mostly idle between probes |
| Probe latency | <3000ms | Configurable timeout |
| State change latency | <1ms | In-memory state machine |
| Cache write latency | ~10ms | Filesystem operation |
| Notification latency | <1s | HTTP webhook |

## Deployment Size

| Component | Size | Notes |
|-----------|------|-------|
| Source code | ~50KB | TypeScript files |
| Compiled JS | ~80KB | Without node_modules |
| Docker image | ~200MB | With Node.js 20 |

---

See individual documentation files for detailed information on each component.
