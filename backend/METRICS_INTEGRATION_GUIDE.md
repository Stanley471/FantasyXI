# Metrics Integration Guide

This guide shows how to integrate Prometheus metrics collection with existing FantasyXI services (queues, database, etc).

## Quick Start

### 1. HTTP Metrics (Already Automatic)

The metrics middleware is already attached in `server.ts`. All HTTP requests are automatically tracked.

### 2. Add Database Metrics to Existing Queries

Before (existing code):
```typescript
const users = await prisma.user.findMany({
  where: { status: "active" }
});
```

After (with metrics):
```typescript
import { traceDbQuery } from "../config/tracing.js";

const users = await traceDbQuery("User", "findMany", () =>
  prisma.user.findMany({
    where: { status: "active" }
  })
);
```

The `traceDbQuery` wrapper automatically:
- Records query duration in `db_query_duration_ms` histogram
- Increments success/error counters
- Links to distributed trace context
- Sanitizes sensitive attributes

**Key metrics recorded:**
- `db_query_duration_ms` - Query latency (1-2500ms buckets)
- `db_queries_total` - Count by model, operation, status
- `db_slow_queries_total` - Queries >100ms

### 3. Add Queue Metrics to BullMQ

In your queue initialization (e.g., `jobQueue.ts`):

```typescript
import { QueueMetricsCollector } from "../services/metrics/queueMetricsCollector.js";

// After creating queues...
const emailQueue = new Queue("email-jobs", { connection: redis });
const scoringQueue = new Queue("scoring-jobs", { connection: redis });

// Update metrics every 30 seconds
setInterval(async () => {
  await QueueMetricsCollector.updateQueueMetrics(emailQueue);
  await QueueMetricsCollector.updateQueueMetrics(scoringQueue);
}, 30000);

// Track job completion
emailQueue.on("completed", (job, result) => {
  const durationMs = Date.now() - job.progress();
  QueueMetricsCollector.recordJobDuration("email-jobs", durationMs, "success");
});

emailQueue.on("failed", (job, err) => {
  const durationMs = Date.now() - job.progress();
  QueueMetricsCollector.recordJobDuration("email-jobs", durationMs, "failed");
});
```

**Key metrics recorded:**
- `bull_queue_depth` - Pending jobs per queue
- `bull_queue_processing` - Currently active jobs
- `bull_job_duration_ms` - Job latency (100-60000ms buckets)

### 4. Monitor Connection Pool Health

During health checks or periodic updates:

```typescript
import { DbMetricsCollector } from "../services/metrics/dbMetricsCollector.js";

// Update pool metrics (e.g., in your health check endpoint)
app.get("/api/health/database", (req, res) => {
  const poolSize = getPoolSize(); // Your method to get current connections
  const maxSize = 20; // Your configured max
  
  DbMetricsCollector.updateConnectionPoolMetrics(poolSize, maxSize);
  
  res.json({
    success: true,
    data: { poolSize, maxSize }
  });
});
```

**Key metrics recorded:**
- `db_connection_pool_size` - Current connections
- `db_connection_pool_capacity` - Max capacity

## Integration Checklist

### Phase 1: HTTP Metrics (Done ✓)
- [x] Middleware attached in `server.ts`
- [x] All HTTP requests tracked automatically
- [x] `/metrics` endpoint protected by service key

### Phase 2: Database Metrics (Todo)
- [ ] Identify top database operations to instrument
- [ ] Wrap `traceDbQuery` around Prisma calls in:
  - `services/financial/financialService.ts`
  - `services/leagueService.ts`
  - `services/auth/authService.ts`
  - Other critical data access layers
- [ ] Test metrics collection with sample queries

### Phase 3: Queue Metrics (Todo)
- [ ] Add metrics collection to `queues/jobQueue.ts`
- [ ] Track major queue types:
  - Email jobs
  - Scoring calculations
  - Financial settlements
  - Background processing
- [ ] Record job completion timing

### Phase 4: Connection Pool Health (Todo)
- [ ] Call `DbMetricsCollector.updateConnectionPoolMetrics()` in health checks
- [ ] Set up periodic pool status updates
- [ ] Monitor for pool exhaustion patterns

## Example: Instrumented Service

Here's an example of a fully instrumented service:

```typescript
// services/scoringService.ts
import { traceDbQuery } from "../config/tracing.js";
import { DbMetricsCollector } from "../services/metrics/dbMetricsCollector.js";

export class ScoringService {
  async calculateWeeklyScores(gameweekId: number): Promise<void> {
    // Metric: Load players for scoring
    const players = await traceDbQuery("Player", "findMany", () =>
      prisma.player.findMany({
        where: { active: true },
        include: { stats: true }
      })
    );

    // Metric: Store calculated scores
    const scores = calculateScores(players);
    
    await traceDbQuery("PlayerScore", "createMany", () =>
      prisma.playerScore.createMany({
        data: scores
      })
    );

    // Metric: Update leaderboards
    const leagues = await traceDbQuery("League", "findMany", () =>
      prisma.league.findMany({
        where: { active: true }
      })
    );

    for (const league of leagues) {
      await traceDbQuery("LeagueScore", "upsert", () =>
        prisma.leagueScore.upsert({
          where: { leagueId: league.id },
          create: { leagueId: league.id, score: 0 },
          update: { updatedAt: new Date() }
        })
      );
    }
  }
}
```

Metrics collected:
- 3 separate database operations tracked
- Latency data for each operation type
- Success/error counts by operation

## Accessing Metrics

### View Raw Prometheus Format

```bash
curl -H "X-Service-Key: your-key" http://localhost:5000/metrics | head -50
```

Sample output:
```
# HELP http_request_duration_ms HTTP request latency in milliseconds
# TYPE http_request_duration_ms histogram
http_request_duration_ms_bucket{le="10",method="GET",route="/api/v1/leagues",status="200"} 15
http_request_duration_ms_bucket{le="50",method="GET",route="/api/v1/leagues",status="200"} 42
http_request_duration_ms_bucket{le="100",method="GET",route="/api/v1/leagues",status="200"} 89
http_request_duration_ms_bucket{le="250",method="GET",route="/api/v1/leagues",status="200"} 127
http_request_duration_ms_bucket{le="500",method="GET",route="/api/v1/leagues",status="200"} 150
http_request_duration_ms_bucket{le="+Inf",method="GET",route="/api/v1/leagues",status="200"} 150
http_request_duration_ms_sum{method="GET",route="/api/v1/leagues",status="200"} 6750
http_request_duration_ms_count{method="GET",route="/api/v1/leagues",status="200"} 150
```

### View JSON Format (Debugging)

```bash
curl -H "X-Service-Key: your-key" http://localhost:5000/metrics/json | jq .
```

### Calculate Percentiles Manually

From the histogram buckets above:
- p50: ~45ms (halfway through cumulative distribution)
- p95: ~95ms (95% of requests < 95ms)
- p99: ~100ms (99% of requests < 100ms)

## Testing Your Integration

### Test HTTP Metrics

```bash
# Make requests to trigger metrics
curl http://localhost:5000/api/v1/leagues
curl http://localhost:5000/api/v1/leagues
curl http://localhost:5000/api/v1/leagues

# View metrics
curl -H "X-Service-Key: your-key" http://localhost:5000/metrics | grep "http_requests_total"
```

### Test Database Metrics

```typescript
// In your test file
import { QueueMetricsCollector } from "../services/metrics/queueMetricsCollector.js";

test("database metrics are recorded", async () => {
  const users = await traceDbQuery("User", "findMany", () =>
    prisma.user.findMany()
  );

  const metrics = await collectMetrics();
  assert(metrics.includes("db_query_duration_ms"));
  assert(metrics.includes('model="User"'));
  assert(metrics.includes('operation="findMany"'));
});
```

### Test Queue Metrics

```typescript
test("queue metrics are updated", async () => {
  const mockQueue = {
    name: "test-queue",
    getJobCounts: async () => ({
      waiting: 10,
      active: 2
    })
  };

  await QueueMetricsCollector.updateQueueMetrics(mockQueue);
  
  const metrics = await collectMetrics();
  assert(metrics.includes("bull_queue_depth"));
  assert(metrics.includes('queue="test-queue"'));
});
```

## Common Integration Patterns

### Pattern 1: Service Layer Instrumentation

```typescript
export class UserService {
  async getUser(userId: string) {
    return traceDbQuery("User", "findUnique", () =>
      prisma.user.findUnique({ where: { id: userId } })
    );
  }

  async listUsers(limit = 10) {
    return traceDbQuery("User", "findMany", () =>
      prisma.user.findMany({ take: limit })
    );
  }
}
```

### Pattern 2: Controller Instrumentation

```typescript
export async function listLeagues(req: Request, res: Response) {
  const leagues = await traceDbQuery("League", "findMany", () =>
    prisma.league.findMany({
      where: { ownerId: req.user!.id }
    })
  );

  res.json({ success: true, data: leagues });
}
```

### Pattern 3: Background Job Instrumentation

```typescript
// In your job handler
emailQueue.process(async (job) => {
  const startTime = Date.now();
  
  try {
    const result = await traceDbQuery("Email", "create", () =>
      prisma.email.create({ data: job.data })
    );
    
    const durationMs = Date.now() - startTime;
    QueueMetricsCollector.recordJobDuration("email-jobs", durationMs, "success");
    
    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    QueueMetricsCollector.recordJobDuration("email-jobs", durationMs, "failed");
    throw error;
  }
});
```

## Performance Considerations

- **Tracing wrapper overhead**: < 1ms per query
- **Metrics collection**: In-memory, no I/O except on `/metrics` request
- **Scrape endpoint**: Returns ~100-500KB of text format metrics
- **Memory usage**: ~50-100MB for default metrics

For high-traffic services, consider:
- Sampling queries (e.g., 1 in 100) instead of all
- Periodic metrics reset (e.g., daily)
- External metrics exporter if memory becomes an issue

## Troubleshooting Integration

### "Cannot find module prom-client"

Ensure dependency is installed:
```bash
npm install prom-client@^15.1.0
```

### Database metrics not appearing

Check that `traceDbQuery` is wrapping your Prisma calls:
```typescript
// Wrong - no metrics
const user = await prisma.user.findUnique({ where: { id: 1 } });

// Correct - metrics recorded
const user = await traceDbQuery("User", "findUnique", () =>
  prisma.user.findUnique({ where: { id: 1 } })
);
```

### Queue metrics stuck at 0

Ensure `updateQueueMetrics()` is called periodically:
```typescript
// Add this to your queue initialization
setInterval(async () => {
  await QueueMetricsCollector.updateQueueMetrics(yourQueue);
}, 30000);
```

### 401 Unauthorized on /metrics

Verify service key is correct:
```bash
# Check environment variable
echo $SERVICE_API_KEYS

# Use correct key format
curl -H "X-Service-Key: your-actual-key" http://localhost:5000/metrics
```

## Next Steps

1. **Phase 2**: Wrap critical database operations with `traceDbQuery`
2. **Phase 3**: Add queue metrics collection to `jobQueue.ts`
3. **Phase 4**: Set up periodic connection pool monitoring
4. **Phase 5** (Out of scope): Configure Prometheus scraper and Grafana dashboards
