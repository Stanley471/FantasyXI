# Multi-Region Read Replicas

FantasyXI keeps a single **primary** PostgreSQL database for all writes and serves
reads from **streaming read replicas** placed close to users. Multi-region *writes*
are out of scope.

```
             writes + consistent reads                 async WAL streaming
 API (eu-west-1) ─────────────────────────► PRIMARY (eu-west-1) ─────────┬──────────► REPLICA (us-east-1)
 API (us-east-1) ──┐                                                     └──────────► REPLICA (ap-south-1)
 API (ap-south-1) ─┴─ GET reads ──► nearest healthy replica (lag <= REPLICA_MAX_LAG_MS)
```

## 1. Database replication

Any PostgreSQL 13+ streaming-replication setup works, including managed options
(Amazon RDS / Aurora cross-region read replicas, Cloud SQL cross-region replicas,
Azure flexible server read replicas). For self-managed PostgreSQL:

**Primary** (`postgresql.conf`):

```ini
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
wal_keep_size = 2GB          # headroom for replicas that briefly disconnect
hot_standby = on
```

**Primary** (`pg_hba.conf`), one line per replica host, TLS only:

```
hostssl replication replicator <replica-ip>/32 scram-sha-256
```

Create a replication role and one slot per region, so WAL is retained until each
replica has consumed it:

```sql
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '<secret>';
SELECT pg_create_physical_replication_slot('replica_us_east_1');
SELECT pg_create_physical_replication_slot('replica_ap_south_1');
```

**Each replica**:

```bash
pg_basebackup -h <primary-host> -U replicator -D "$PGDATA" \
  -X stream -R -S replica_us_east_1 --checkpoint=fast
```

`-R` writes `standby.signal` and `primary_conninfo`. In the replica's
`postgresql.conf` set:

```ini
hot_standby = on
hot_standby_feedback = on             # avoids query cancellations on long reads
max_standby_streaming_delay = 30s
```

Give the API a **read-only** role on the replicas:

```sql
CREATE ROLE fantasyxi_reader LOGIN PASSWORD '<secret>';
GRANT CONNECT ON DATABASE fantasyxi TO fantasyxi_reader;
GRANT USAGE ON SCHEMA public TO fantasyxi_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fantasyxi_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO fantasyxi_reader;
GRANT pg_monitor TO fantasyxi_reader;  -- lets the health check read replication lag
```

Run the grants on the primary; they replicate to the replicas.

## 2. Application configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_REGION` | unset | Region of this API instance, e.g. `us-east-1` |
| `DATABASE_READ_REPLICAS` | empty | Comma-separated `region=postgresql://...` pairs |
| `REPLICA_MAX_LAG_MS` | `5000` | Replicas lagging more than this receive no reads |
| `REPLICA_HEALTH_CHECK_INTERVAL_MS` | `10000` | How often lag and latency are measured |
| `REPLICA_HEALTH_CHECK_TIMEOUT_MS` | `2000` | A slower health check marks the replica unhealthy |

With `DATABASE_READ_REPLICAS` empty, behaviour is unchanged: everything uses `DATABASE_URL`.

## 3. Routing rules

Implemented in `backend/src/config/readReplicas.ts` as a Prisma client extension.

Replica reads are **opt-in per router**. Only read-heavy public data is eligible:
`GET`/`HEAD` requests to `/players`, `/teams`, `/gameweeks`, `/fixtures`, `/leagues` and
`/live`, plus the query-only `/graphql` endpoint. Everything else uses the primary.

| Query | Target |
| --- | --- |
| Reads (`findMany`, `findUnique`, `count`, ...) in an opted-in `GET` request or `/graphql` | Nearest eligible replica |
| Any write | Primary |
| Reads after a write in the same request (read-your-writes) | Primary |
| Reads inside `$transaction` (interactive or batch) | Primary |
| Any `POST`/`PUT`/`PATCH`/`DELETE` request (payments, joins, admin retries) | Primary |
| League financial `GET`s (payment requirement, settlement plan, reconcile) and invitation links | Primary |
| Auth, squads, admin and sync routes | Primary |
| Background jobs and workers (refunds, settlement, event indexer) | Primary |
| Raw SQL (`$queryRaw`, `$executeRaw`) | Primary |
| Requests with header `X-Read-Consistency: strong` | Primary |

To opt another router in, mount it with `replicaReads` in `backend/src/routes/index.ts`.
To keep one of its `GET` routes on the primary (because it writes, or feeds a financial
decision), add `primaryReads` to that route.

**Choosing a replica.** The health checker measures replication lag and round-trip
latency for each replica. A replica is *eligible* when its last check succeeded
and its lag is within `REPLICA_MAX_LAG_MS`. Among eligible replicas the one in
`APP_REGION` wins; otherwise the one with the lowest latency is used. When no
replica is eligible, reads go to the primary.

**Failover.** If a replica query fails with a connection-level error, the replica
is taken out of rotation and the query is transparently re-run on the primary.
The next successful health check brings it back.

## 4. Consistency guarantees

- Replicas are asynchronous. A read served by a replica may be up to
  `REPLICA_MAX_LAG_MS` behind the primary, and never more: lag is re-measured
  every health-check interval, and a lagging replica stops receiving reads.
- Lag is `now() - pg_last_xact_replay_timestamp()`, reported as `0` when the replica
  has replayed all the WAL it received, so an idle primary never makes a replica look stale.
- No read that feeds a financial decision can be stale: payment, refund, payout and
  settlement code paths run in non-GET requests, primary-pinned GET routes or
  background jobs, all of which use the primary.
- A client that needs to read its own write in a later GET request should send
  `X-Read-Consistency: strong`.

## 5. Monitoring

`GET /api/health/replicas` returns each replica's health, eligibility, lag and latency:

```json
{
  "enabled": true,
  "appRegion": "us-east-1",
  "replicas": [
    { "region": "us-east-1", "healthy": true, "eligible": true, "lagMs": 12, "latencyMs": 1.8 },
    { "region": "ap-south-1", "healthy": true, "eligible": false, "lagMs": 9400, "latencyMs": 212.5 }
  ]
}
```

Alert when `eligible` stays `false` for a region, or when replication slots on the
primary retain an unusual amount of WAL (`pg_replication_slots`).

## 6. Benchmarking (before / after)

From an API host in each region:

```bash
cd backend
APP_REGION=ap-south-1 BENCH_ITERATIONS=500 BENCH_CONCURRENCY=8 npm run db:benchmark-replicas
```

The script runs the public league search workload first against the primary only
("before") and then through the replica router ("after"), and prints p50/p95/p99
latency and throughput for both. Record the results per region when rolling out
a new replica.
