# Architecture Documentation

## System Design

### High-Level Overview

The FPL API Health Monitor implements a resilient data access pattern with automatic degradation detection and seamless failover:

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Application                        │
│              (FPL Scoring Pipeline, UI, API)                 │
└────────────────────────┬────────────────────────────────────┘
                         │
                         v
        ┌────────────────────────────────┐
        │   FPL Health Monitor Service    │
        │  (Orchestrates all components) │
        └────────────┬───────────────────┘
                     │
        ┌────────────┴────────────────┬─────────────┐
        │                             │             │
        v                             v             v
   ┌─────────────┐            ┌──────────────┐  ┌─────────┐
   │   Canary    │            │   Backup     │  │Notifier │
   │   Service   │            │   Scraper    │  │ Service │
   │             │            │              │  │         │
   │ • Probes    │            │ • Primary    │  │ • Discord
   │   every 30s │            │   cache      │  │ • Slack
   │ • Detects   │            │ • Backup     │  │ • Custom
   │   429, 502, │            │   API        │  │  hooks
   │   timeout   │            │ • Fallback   │  │
   │ • Validates │            │   data       │  │
   │   schema    │            │              │  │
   └─────────────┘            └──────────────┘  └─────────┘
        │
        v
   ┌─────────────────┐
   │  Circuit        │
   │  Breaker        │
   │                 │
   │ CLOSED → OPEN   │
   │         → HALF  │
   │           OPEN  │
   └─────────────────┘
```

## Component Responsibilities

### 1. Health Canary (health-canary.ts)

**Purpose**: Continuously monitor FPL API health

**Responsibilities**:
- Execute health probes every 30 seconds
- Measure response times and status codes
- Validate JSON schema
- Detect degradation indicators
- Report metrics and status
- Manage probe lifecycle

**Key Methods**:
```typescript
start()              // Begin periodic probing
stop()               // Stop probes
probe()              // Execute single probe (private)
getMetrics()         // Return current metrics
getCircuitBreakerStatus()  // Return CB state
isPrimaryHealthy()   // Quick health check
getCurrentProvider() // Which source to use
```

**Degradation Detection**:
- HTTP 429: Rate limiting
- Timeout: Response > 3000ms
- Schema change: Missing/invalid fields
- HTTP 502+: Server errors
- Connection errors: Network issues

### 2. Circuit Breaker (circuit-breaker.ts)

**Purpose**: Manage state transitions and failover decisions

**Responsibilities**:
- Track probe success/failure counts
- Manage state machine (CLOSED → OPEN → HALF_OPEN)
- Notify on state changes
- Enable/prevent recovery testing
- Track failure history

**State Machine**:
```
CLOSED (Healthy)
  ├─ recordSuccess() → stay CLOSED
  ├─ recordFailure(3x) → OPEN
  └─ isOpen() → false

OPEN (Degraded)
  ├─ recordSuccess() → count up
  ├─ recordFailure() → reset counter
  ├─ testRecovery() → HALF_OPEN
  └─ isOpen() → true

HALF_OPEN (Testing)
  ├─ recordSuccess() → CLOSED
  ├─ recordFailure() → back to OPEN
  └─ isOpen() → true
```

**Key Thresholds**:
- Failure threshold: 3 consecutive failures
- Recovery threshold: 5 consecutive successes in HALF_OPEN
- State change listeners: Async notification system

### 3. Schema Validator (schema-validator.ts)

**Purpose**: Validate FPL API response structure

**Responsibilities**:
- Define expected schema for FPL bootstrap endpoint
- Validate incoming responses
- Detect missing critical fields
- Identify type mismatches
- Distinguish significant schema changes

**Validated Fields**:
```typescript
events[]       // Must contain: id, name, deadline_time
teams[]        // Must contain: id, name, code, short_name
elements[]     // Must contain: id, first_name, second_name, element_type, team
element_types[]// Must contain: id, plural_name
```

**Significance Rules**:
- Missing critical fields = significant
- Type errors in events/elements = significant
- Extra unknown fields = not significant
- Changes in optional fields = not significant

### 4. Backup Scraper (backup-scraper.ts)

**Purpose**: Manage fallback data sources

**Responsibilities**:
- Fetch from secondary API provider
- Maintain local filesystem cache
- Provide emergency fallback data
- Track cache age and validity
- Implement fallback hierarchy

**Fallback Strategy** (in order):
```
1. Backup API (secondary provider)
   ↓ (if fails)
2. Local Filesystem Cache (last known good)
   ↓ (if missing/corrupted)
3. Emergency Fallback Data (static, minimal but valid)
```

**Cache Management**:
- Auto-updates on successful backup API or primary API fetch
- Persisted to disk for durability
- Tracks update timestamp
- Graceful load on startup

**Emergency Fallback Data**:
- Valid FPL schema structure
- All 20 Premier League teams
- Empty elements (player data) - only structure
- All 4 element types
- Marked with `_metadata.emergency_fallback: true`

### 5. Notifier Service (notifier.ts)

**Purpose**: Send admin notifications on state changes

**Responsibilities**:
- Format failover/recovery events
- Send to Discord webhook
- Send to Slack webhook
- Include metrics in notifications
- Handle notification failures gracefully

**Notification Payload**:
```json
{
  "type": "FAILOVER|RECOVERY",
  "fromProvider": "PRIMARY|BACKUP|FALLBACK",
  "toProvider": "PRIMARY|BACKUP|FALLBACK",
  "reason": "Rate limit detected",
  "timestamp": 1234567890,
  "metrics": {
    "probesExecuted": 42,
    "successRate": "71.43%",
    "avgResponseTime": "1250.5ms"
  },
  "circuitBreaker": {
    "state": "OPEN",
    "failureCount": 3
  }
}
```

**Webhook Format**:
- Discord: Rich embeds with fields
- Slack: Attachments with sections
- Custom: Async callback pattern

### 6. Service Orchestrator (index.ts)

**Purpose**: Coordinate all components

**Responsibilities**:
- Initialize all services
- Wire event handlers
- Manage lifecycle
- Provide public API
- Handle graceful shutdown

**Public Methods**:
```typescript
start()                    // Start monitoring
stop()                     // Stop all services
getStatus()                // Get comprehensive status
fetchBootstrapData()       // Get data from primary or backup
```

## Data Flow Patterns

### Healthy Path (Primary Success)

```
Client requests data
    ↓
Check if primary healthy
    ↓ (Yes)
Fetch from primary FPL API
    ↓
Validate schema
    ↓ (Valid)
Return data directly
    ↓
Client receives FPL data
```

### Degradation Detection Path

```
Health probe executes
    ↓
Detect degradation (429, timeout, schema change)
    ↓
Record failure
    ↓
Count reaches threshold (3)
    ↓
Circuit breaker opens
    ↓
Notify listeners (failover event)
    ↓
Notifier sends Discord/Slack webhook
```

### Failover Path

```
Client requests data
    ↓
Check if primary healthy
    ↓ (No - circuit open)
Try backup API
    ↓ (Success)
Cache result locally
    ↓
Return data to client
    ↓
Log metrics
```

### Recovery Path

```
Circuit open for 2x probe interval
    ↓
Attempt recovery test (half-open)
    ↓
Execute health probe
    ↓ (Success)
Record success count
    ↓
Reach recovery threshold (5 successes)
    ↓
Circuit closes
    ↓
Switch back to primary
    ↓
Send recovery notification
```

## Sequence Diagrams

### Scenario: Primary API Returns 429 Rate Limit

```
Time  Canary          CB         Notifier
│
├─> probe()
│   │ GET /bootstrap-static/
│   │ ← 429 Too Many Requests
│   │
│   ├─> recordFailure("429 Rate limit")
│   │
│   └─ failureCount = 1
│
├─> probe()
│   │ GET /bootstrap-static/
│   │ ← 429 Too Many Requests
│   │
│   ├─> recordFailure("429 Rate limit")
│   │
│   └─ failureCount = 2
│
├─> probe()
│   │ GET /bootstrap-static/
│   │ ← 429 Too Many Requests
│   │
│   ├─> recordFailure("429 Rate limit")
│   │
│   ├─> failureCount = 3 → THRESHOLD
│   │
│   ├─> transitionTo(OPEN)
│   │   ├─> fire onStateChange callback
│   │   │
│   │   └─────────────────────────> notify()
│   │                               │
│   │                               ├─> POST Discord webhook
│   │                               ├─> POST Slack webhook
│   │                               │
│   │                               └─ notification sent
│   │
│   └─ STATE: OPEN (using BACKUP now)
```

### Scenario: Recovery After Stability Verified

```
Time  Canary          CB         Recovery
│
├─ STATE: OPEN (has been for 60s)
│
├─> testRecovery()
│   │
│   └─> STATE: HALF_OPEN
│
├─> probe()
│   │ GET /bootstrap-static/
│   │ ← 200 OK (valid schema)
│   │
│   ├─> recordSuccess()
│   │
│   └─ successCount = 1
│
├─> probe()
│   │ GET /bootstrap-static/
│   │ ← 200 OK (valid schema)
│   │
│   ├─> recordSuccess()
│   │
│   └─ successCount = 2
│
├─> probe()
│   │ GET /bootstrap-static/
│   │ ← 200 OK (valid schema)
│   │
│   ├─> recordSuccess()
│   │
│   └─ successCount = 3
│
├─> probe()
│   │ GET /bootstrap-static/
│   │ ← 200 OK (valid schema)
│   │
│   ├─> recordSuccess()
│   │
│   └─ successCount = 4
│
├─> probe()
│   │ GET /bootstrap-static/
│   │ ← 200 OK (valid schema)
│   │
│   ├─> recordSuccess()
│   │
│   ├─> successCount = 5 → THRESHOLD
│   │
│   ├─> transitionTo(CLOSED)
│   │
│   └─ STATE: CLOSED (using PRIMARY now)
│       └─ send RECOVERY notification
```

## Error Handling Strategy

### Graceful Degradation

All components implement defensive error handling:

1. **Probe Failures**: Logged but don't crash service
2. **Schema Validation**: Falls back to treating as unhealthy
3. **Cache Loading**: Continues if cache missing/corrupted
4. **Notification Errors**: Logged but non-blocking
5. **Missing Env Vars**: Use sensible defaults

### Fallback Priority

When a data request is made:

```typescript
try {
  // 1. Try primary (if circuit closed)
  if (circuitBreaker.isClosed()) {
    return await fetchPrimary();
  }
} catch (e) {}

try {
  // 2. Try backup API
  return await backupScraper.fetchFromBackupAPI();
} catch (e) {}

try {
  // 3. Try local cache
  return await backupScraper.fetchFromFallbackCache();
} catch (e) {}

// 4. Return emergency fallback
return backupScraper.getEmergencyFallbackData();
```

## Performance Characteristics

### Time Complexity

- Probe execution: O(n) where n = response size (constant typical)
- Circuit breaker state check: O(1)
- Schema validation: O(n) where n = fields to validate (~10 fields)
- Metrics calculation: O(m) where m = history size (max 100)

### Space Complexity

- Response time history: O(100) bounded
- Degradation indicators: O(50) bounded
- Active probes: O(1) concurrent per interval
- Total memory: ~50-100MB typical

### Throughput

- Probe interval: 30 seconds (configurable)
- Probe timeout: 3 seconds (configurable)
- Recovery test interval: 60 seconds
- Max concurrent operations: 2 (probe + recovery test)

## Scalability Considerations

### Horizontal Scaling

Multiple instances can run independently:
- Shared fallback cache via NFS/S3
- Independent circuit breaker state (converges)
- Broadcast notifications to same webhook

### Vertical Scaling

Service is CPU/memory efficient:
- Minimal CPU usage (mostly idle)
- Bounded memory (fixed history sizes)
- No unbounded queues

### Integration Points

- Fits into existing data pipelines
- Non-blocking notifications
- Async failure handling
- No synchronous dependencies

## Testing Strategy

### Unit Tests

- Schema validator: Input validation
- Circuit breaker: State transitions
- Health canary: Metric collection
- Notifier: Payload formatting

### Integration Tests

- End-to-end failover scenario
- Recovery flow
- Notification delivery

### Chaos Tests

Real-world degradation scenarios:
1. Rate limiting (HTTP 429)
2. Latency spikes (>3s)
3. Bad gateway (HTTP 502)
4. Schema validation failures
5. Connection timeouts
6. Flaky service (intermittent failures)
7. 60-second failover requirement
8. Data continuity verification

## Security Model

### Data Protection

- Webhook URLs stored in environment variables
- No secrets logged
- Fallback data doesn't contain sensitive player data
- Cache persisted locally (not transmitted)

### Access Control

- Circuit breaker state machine prevents cascading failures
- Rate limiting detection prevents abuse of backup sources
- Recovery testing prevents flip-flopping

### Monitoring

- All state transitions logged
- Metrics tracked for audit
- Notifications include decision context

## Future Enhancement Points

1. **Adaptive Thresholds**: ML-based tuning of timeouts/thresholds
2. **Multi-Region Failover**: Geographic distribution
3. **Distributed Circuit Breaker**: Shared state across instances
4. **Metrics Aggregation**: Prometheus/Grafana integration
5. **Alert Rules**: Trigger actions on thresholds
6. **Cache Versioning**: Incremental updates instead of full sync
7. **Compression**: Reduce cache file size
8. **Retry Logic**: Exponential backoff for transient failures
