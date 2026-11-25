# Metrics Implementation Verification Checklist

Use this checklist to verify the Prometheus metrics implementation is complete and working.

## Pre-Installation

- [ ] Review `IMPLEMENTATION_SUMMARY.md` for architecture overview
- [ ] Review `METRICS_SETUP.md` for configuration details
- [ ] Check `package.json` includes `"prom-client": "^15.1.0"`

## Installation & Configuration

- [ ] Run `npm install` to add prom-client dependency
- [ ] Generate service key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] Set `SERVICE_API_KEYS` environment variable with generated key
- [ ] Verify `SERVICE_API_KEYS` format: `"name:key,other:key"`

## Server Startup

- [ ] Start server: `npm run dev`
- [ ] Verify no TypeScript compilation errors
- [ ] Check console for successful server start message
- [ ] Verify middleware attached (no warnings about missing metricsMiddleware)

## HTTP Metrics Verification

- [ ] Make a request: `curl http://localhost:5000/api/health`
- [ ] Verify response is normal (metrics don't interfere)
- [ ] Make multiple requests to different routes
- [ ] Access `/metrics` with valid service key
- [ ] Verify `http_requests_total` shows the requests
- [ ] Verify `http_request_duration_ms` histogram has buckets

### Expected Prometheus Output
```
# HELP http_request_duration_ms HTTP request latency in milliseconds
# TYPE http_request_duration_ms histogram
http_request_duration_ms_bucket{le="10",...} X
http_request_duration_ms_bucket{le="50",...} X
...
http_request_duration_ms_sum{...} X
http_request_duration_ms_count{...} X
```

## Authentication Verification

- [ ] Test `/metrics` without service key → 401 response
- [ ] Test `/metrics` with invalid key → 401 response
- [ ] Test `/metrics` with valid key → 200 response
- [ ] Verify correct `Content-Type: text/plain` header

### Test Commands
```bash
# Should fail
curl http://localhost:5000/metrics

# Should fail
curl -H "X-Service-Key: invalid" http://localhost:5000/metrics

# Should succeed
curl -H "X-Service-Key: your-service-key" http://localhost:5000/metrics
```

## Prometheus Format Verification

- [ ] Endpoint returns text format (not JSON by default)
- [ ] Output includes `# HELP` comments
- [ ] Output includes `# TYPE` comments
- [ ] Metrics use proper naming (snake_case with _total, _bucket, _sum, _count suffixes)
- [ ] No errors in metric format

### Validation
```bash
# Check format is valid
curl -H "X-Service-Key: key" http://localhost:5000/metrics | head -20

# Should show lines like:
# # HELP http_request_duration_ms HTTP request latency in milliseconds
# # TYPE http_request_duration_ms histogram
```

## HTTP Metrics Validation

- [ ] Histogram buckets present for `http_request_duration_ms`
- [ ] Buckets: 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000 ms ✓
- [ ] Labels include: method, route, status ✓
- [ ] `http_requests_total` counter present ✓
- [ ] `http_errors_total` counter present ✓
- [ ] `app_uptime_seconds` gauge present ✓

### Verify with Grep
```bash
curl -s -H "X-Service-Key: key" http://localhost:5000/metrics | grep "http_request_duration_ms_bucket" | head -3
```

## Database Metrics Validation

- [ ] `db_query_duration_ms` histogram present
- [ ] `db_queries_total` counter present
- [ ] `db_connection_pool_size` gauge present
- [ ] Database metrics use proper labels (model, operation, status)

## Queue Metrics Validation

- [ ] `bull_queue_depth` gauge present
- [ ] `bull_queue_processing` gauge present
- [ ] `bull_job_duration_ms` histogram present
- [ ] Queue metrics use proper labels (queue, status)

## Process Metrics Validation

- [ ] `process_cpu_usage_seconds_total` present (Node.js process metrics)
- [ ] `process_resident_memory_bytes` present
- [ ] `nodejs_version_info` present
- [ ] Standard Prometheus metrics are collected

```bash
curl -s -H "X-Service-Key: key" http://localhost:5000/metrics | grep "^process_" | head -5
```

## Debug Endpoint Verification

- [ ] Access `/metrics/json` with valid service key
- [ ] Returns HTTP 200 with JSON body
- [ ] JSON includes `success: true`
- [ ] JSON includes `timestamp` in ISO format
- [ ] JSON includes `metrics` array

### Test JSON Endpoint
```bash
curl -H "X-Service-Key: key" http://localhost:5000/metrics/json | jq '.timestamp'
```

## Test Suite Verification

- [ ] Run tests: `npm test -- src/tests/metrics.test.ts`
- [ ] All HTTP metrics tests pass ✓
- [ ] All database metrics tests pass ✓
- [ ] All queue metrics tests pass ✓
- [ ] All authentication tests pass ✓
- [ ] All format validation tests pass ✓
- [ ] 40+ total test cases pass

### Run Tests
```bash
npm test -- src/tests/metrics.test.ts 2>&1 | tail -20
```

## Integration Points Verification

### Tracing Integration
- [ ] `src/config/tracing.ts` imports metrics collectors
- [ ] `traceDbQuery()` records both spans AND metrics
- [ ] Database queries show up in `/metrics` output

### Middleware Stack
- [ ] `metricsMiddleware` is first in stack (after trust proxy)
- [ ] All requests captured including GraphQL
- [ ] No middleware conflicts

### Service Auth
- [ ] `/metrics` protected by `requireAuth` middleware
- [ ] Service key validation uses constant-time comparison
- [ ] 401 response for missing/invalid keys

## Performance Verification

- [ ] Server startup time is normal (< 2 seconds)
- [ ] Request latency not significantly affected by metrics middleware
- [ ] Memory usage reasonable (~50-100MB for metrics)
- [ ] `/metrics` endpoint responds in < 500ms

### Check Memory
```bash
# After starting server, check process memory
node -e "console.log(process.memoryUsage())" 
```

## Content Type Header Verification

- [ ] `/metrics` returns `Content-Type: text/plain; version=0.0.4`
- [ ] Can be parsed by Prometheus scraper
- [ ] Browser displays as text, not as download

```bash
curl -i -H "X-Service-Key: key" http://localhost:5000/metrics | grep -i content-type
```

## Error Handling Verification

- [ ] Invalid route generates 404 metric
- [ ] Server errors (5xx) are tracked
- [ ] Client errors (4xx) are tracked separately
- [ ] Errors don't break metrics collection

### Test Error Tracking
```bash
# Trigger a 404
curl http://localhost:5000/nonexistent

# Check metrics show the error
curl -s -H "X-Service-Key: key" http://localhost:5000/metrics | grep "404"
```

## Complete Acceptance Criteria

### Criterion 1: /metrics Endpoint Exports Prometheus Format ✓
- [ ] Endpoint exists at `GET /metrics`
- [ ] Returns Prometheus text format
- [ ] Includes HELP and TYPE comments
- [ ] Properly formatted metric lines

### Criterion 2: Endpoint Protected by Service Key ✓
- [ ] Returns 401 without X-Service-Key header
- [ ] Returns 401 with invalid X-Service-Key
- [ ] Returns 200 with valid X-Service-Key
- [ ] Uses constant-time comparison
- [ ] Prevents timing attacks

### Criterion 3: Histogram Metrics Track Percentiles ✓
- [ ] `http_request_duration_ms` histogram present
- [ ] Buckets support p50, p95, p99 calculations
- [ ] Labeled by method, route, status
- [ ] Can compute: `histogram_quantile(0.95, ...)`

### Criterion 4: Tests Verify Functionality ✓
- [ ] Metrics collection tests pass (HTTP, DB, Queue)
- [ ] Endpoint authorization tests pass
- [ ] Format validation tests pass
- [ ] 40+ comprehensive test cases

## Optional Enhancements (Out of Scope)

- [ ] Prometheus scraper configured to hit `/metrics`
- [ ] Grafana dashboards created
- [ ] Alert rules configured
- [ ] Historical metrics storage (time-series DB)
- [ ] Custom metrics added for business logic

## Documentation Review

- [ ] `METRICS_SETUP.md` is complete and accurate
- [ ] `METRICS_INTEGRATION_GUIDE.md` provides clear examples
- [ ] `IMPLEMENTATION_SUMMARY.md` documents architecture
- [ ] `METRICS_QUICK_REFERENCE.md` useful for developers
- [ ] All code is documented with JSDoc comments

## Sign-Off

- [ ] All items above checked
- [ ] No critical issues remaining
- [ ] Implementation ready for production
- [ ] Service key configured and stored securely

**Verified By:** ___________________________  
**Date:** ___________________________  
**Notes:** 

---

## Troubleshooting During Verification

### "Cannot find module prom-client"
- [ ] Run `npm install prom-client`
- [ ] Verify installation: `npm list prom-client`

### "401 Unauthorized" on /metrics
- [ ] Check SERVICE_API_KEYS env var is set
- [ ] Verify key format: `name:key`
- [ ] Verify X-Service-Key header sent in curl

### Metrics not appearing
- [ ] Make requests to server (metrics need traffic)
- [ ] Check middleware is attached in server.ts
- [ ] Verify `/metrics` endpoint is registered

### Test failures
- [ ] Ensure prom-client is installed: `npm install prom-client`
- [ ] Run single test: `npm test -- src/tests/metrics.test.ts`
- [ ] Check TypeScript compilation: `npx tsc --noEmit`

### Performance issues
- [ ] Check if many services are scraping simultaneously
- [ ] Consider metrics lifecycle (reset old data periodically)
- [ ] Monitor `process_resident_memory_bytes`

---

Implementation verification complete when all checkboxes are marked.
