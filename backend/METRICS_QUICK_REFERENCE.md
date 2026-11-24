# Metrics Quick Reference

## Access Metrics

```bash
# Prometheus format (standard)
curl -H "X-Service-Key: your-key" http://localhost:5000/metrics

# JSON format (debugging)
curl -H "X-Service-Key: your-key" http://localhost:5000/metrics/json
```

## Setup

```bash
# 1. Install
npm install prom-client

# 2. Configure
export SERVICE_API_KEYS="monitoring:$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))')"

# 3. Start
npm run dev

# 4. Test
curl -H "X-Service-Key: your-key" http://localhost:5000/metrics
```

## Code Examples

### Track Database Query Latency
```typescript
import { traceDbQuery } from "../config/tracing.js";

// Before
const user = await prisma.user.findUnique({ where: { id: 1 } });

// After (adds metrics automatically)
const user = await traceDbQuery("User", "findUnique", () =>
  prisma.user.findUnique({ where: { id: 1 } })
);
```

### Track Queue Metrics
```typescript
import { QueueMetricsCollector } from "../services/metrics/queueMetricsCollector.js";

// Update queue depth (call periodically)
setInterval(async () => {
  await QueueMetricsCollector.updateQueueMetrics(emailQueue);
}, 30000);

// Record job completion
QueueMetricsCollector.recordJobDuration("email-jobs", 5000, "success");
```

### Update Connection Pool Status
```typescript
import { DbMetricsCollector } from "../services/metrics/dbMetricsCollector.js";

DbMetricsCollector.updateConnectionPoolMetrics(currentConnections, maxConnections);
```

## Metrics Available

### HTTP
| Metric | Type | Description |
|--------|------|-------------|
| `http_request_duration_ms` | Histogram | Request latency (p50, p95, p99) |
| `http_requests_total` | Counter | Total requests by method/route/status |
| `http_errors_total` | Counter | 4xx and 5xx errors |
| `app_uptime_seconds` | Gauge | Server uptime |

### Database
| Metric | Type | Description |
|--------|------|-------------|
| `db_query_duration_ms` | Histogram | Query latency by model/operation |
| `db_queries_total` | Counter | Query count by status |
| `db_slow_queries_total` | Gauge | Queries > 100ms |
| `db_connection_pool_size` | Gauge | Current connections |

### Queue
| Metric | Type | Description |
|--------|------|-------------|
| `bull_queue_depth` | Gauge | Pending jobs per queue |
| `bull_job_duration_ms` | Histogram | Job latency by queue/status |

## Prometheus Queries

```promql
# HTTP Response time percentiles
histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m]))

# Error rate per route
rate(http_errors_total[5m])

# Database query latency p99
histogram_quantile(0.99, rate(db_query_duration_ms_bucket[5m]))

# Slow queries per minute
rate(db_slow_queries_total[1m])

# Queue depth
bull_queue_depth{queue="email-jobs"}
```

## Testing

```bash
# Run metrics tests
npm test -- src/tests/metrics.test.ts

# Test endpoint
curl -H "X-Service-Key: test-key" http://localhost:5000/metrics

# View as JSON
curl -H "X-Service-Key: test-key" http://localhost:5000/metrics/json | jq
```

## Common Issues

| Problem | Solution |
|---------|----------|
| 401 on `/metrics` | Check SERVICE_API_KEYS env var and X-Service-Key header |
| No database metrics | Wrap Prisma calls with `traceDbQuery()` |
| Queue metrics at 0 | Call `updateQueueMetrics()` periodically |
| Memory spike | Normal: metrics kept in memory. ~50-100MB typical |

## Files

| File | Purpose |
|------|---------|
| `src/config/metrics.ts` | Prometheus registry and metric definitions |
| `src/middleware/metricsMiddleware.ts` | Auto HTTP tracking |
| `src/controllers/metrics.controller.ts` | /metrics endpoint |
| `src/services/metrics/dbMetricsCollector.ts` | Database helpers |
| `src/services/metrics/queueMetricsCollector.ts` | Queue helpers |
| `src/tests/metrics.test.ts` | Test suite (40+ tests) |

## Documentation

- `METRICS_SETUP.md` - Complete setup and configuration
- `METRICS_INTEGRATION_GUIDE.md` - Integration patterns and examples
- `IMPLEMENTATION_SUMMARY.md` - Detailed implementation overview

---

Ready to use. Install `prom-client` and configure `SERVICE_API_KEYS` to get started.
