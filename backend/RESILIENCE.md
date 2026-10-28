# Financial and matchday resilience

This suite addresses #317, #319, and #320. All network faults are injected into
isolated tests. No test needs a funded Stellar account or calls mainnet.

## Run locally

Use disposable PostgreSQL 16 and Redis 7 instances. Install backend dependencies,
then set `CHAOS_DATABASE_URL` and `FANOUT_REDIS_URL` to those instances. Set
`DATABASE_URL` to the same test database, run `npx prisma db push`, and run:

```sh
npm run build
REDIS_ENABLED=false npm run test:resilience
REDIS_ENABLED=false npm run test:resilience:integration
FANOUT_LOAD_SECONDS=30 npm run test:fanout:load
```

The integration runner skips service-dependent tests when their explicit test
URLs are absent; the scheduled workflow always supplies both URLs. Database tests
create uniquely named fixtures and remove only their own records. They deliberately
terminate transaction connections and inject commit latency. The deterministic
suite intercepts RPC calls with timeouts, full drops, resets, delayed responses,
and response loss after a remote commit. It asserts unchanged balances/statuses,
atomic rollback, recoverable journal entries, and one ledger across worker retries.

`.github/workflows/resilience.yml` runs unit, real-service integration, and a
30-second producer soak on PRs and nightly; it saves the load report as an artifact.
The soak generates 50,000 events/s with a fixed-size producer loop, checks RSS
below 500 MiB, bounded Redis retention, actual peer deliveries, and zero errors.
It reports measured throughput rather than assuming the offered rate was achieved.

For real WebSocket consumers, start the API against the same Redis, with
`JOB_QUEUE_ENABLED=false` and `TX_COORDINATOR_ENABLED=false`. Generate a local
test JWT with the API's test secret, run the producer soak concurrently, and run:

```sh
k6 run -e TOKEN="$LOCAL_TEST_JWT" \
  -e WS_URL=ws://localhost:5000/api/v1/live/1/ws \
  -e CLIENTS=100 loadtest/matchday-fanout.js
```

Increase `CLIENTS` to size the deployment; a 100-client check is not a claim that
tens of thousands of real connections were exercised on a developer machine.

## Read consistency

`DATABASE_READ_REPLICAS` retains its existing region-to-URL syntax. The default
`REPLICA_MAX_LAG_MS` is now 200 and health polling defaults to 1000ms. Unknown,
negative, or health samples older than 5s are ineligible. Health polling compares
the replica's replay position with the writer's WAL position, so a disconnected
replica whose receive and replay positions are equal cannot report a false zero.
The replay timestamp estimates milliseconds when behind; physical replication
and actual geographic latency should also be measured in deployment.

Authenticated user mutations set a shared Redis fence before dispatch and refresh
it after completion; transaction wrappers refresh it after commit/rollback too.
Further requests for that user use the primary for five seconds. If the fence
store is unavailable, reads fail closed to primary and mutations requiring replica
consistency are refused before dispatch. With no replicas, the original
primary-only operation does not require this Redis fence. Existing explicit strong
read headers, financial primary routing, and transaction routing still apply.

Primary fallback reads have a per-process limit of 20 in-flight operations. Three
connection failures open a one-second circuit, followed by a single probe.
Capacity/circuit rejection returns HTTP 503 and never redirects a consistency-
critical read to a stale replica. Prisma's configured database timeouts still
bound the underlying query; the guard never frees a slot while a query runs.

## Live delivery and backpressure

The FPL stats sync publishes absolute changed player/fixture values only after
its database batch commits. `/api/v1/live/:gameweekId/ws` accepts an `auth` JWT
frame and responds with `ready`, then `delta` frames. Fetch HTTP snapshots for
initial state and reconnect repair. The existing SSE feeds remain available.

Redis Streams use an independent group per API instance: a single shared group
would distribute work and miss sockets on other instances. Give every concurrently
running instance a unique, stable `FANOUT_INSTANCE_ID`. Consumers ACK bounded
batches and reclaim abandoned pending work using `XAUTOCLAIM` (Redis >=6.2).
Groups heartbeat with a 60-second expiry; periodic cleanup removes dead-instance
groups and admission limits the deployment to 128 active groups. Stop the fanout
cleanly on SIGTERM. Redis is required when enabled; server startup fails if its
stream cannot be initialized rather than silently running an isolated instance.

Each producer/inbound buffer holds at most 2048 entities, each at most 4096 bytes.
Updates for the same topic/entity merge during the 100ms window. Queue overflow
drops the oldest entity and preserves newer absolute state. Producer pipelines
and consumer reads have only one in-flight batch each (256 events); the shared
stream uses exact `MAXLEN=4096`. Delta frames hold at most 12 events (<64KiB).
This is lossy live delivery, not a durable financial event bus.

Chat's existing message protocol and durable PostgreSQL history are preserved;
its distributed adapter now uses the bounded stream. Chat messages are distinct
entities and are never merged together. A dropped chat frame is repaired from
HTTP history. Each socket allows at most 32 outstanding frames and 256KiB queued
bytes, drops excess frames, and terminates after three consecutive drops. Slow
clients reconnect and resynchronize. The producer soak does not substitute for
capacity measurements with real users, infrastructure, and socket counts.

## Settlement recovery and rollout

Apply the additive `settlement_key` column and unique index before deploying the
new server. This repository has no existing migration baseline: for existing
databases, apply `prisma/migrations/202610190001_settlement_recovery/migration.sql`
with the normal reviewed schema rollout, or use the established schema-push
workflow. Do not run `prisma migrate deploy` against an unbaselined installation.

A settlement records its unique league key, exact signed hash/envelope, and payout
plan in `CoordinatedTransaction` **before** submission. An outage at that point
prevents submission. A second caller cannot replace the signed transaction.
An ambiguous send or poll preserves its hash and does not build a fresh invocation.
`DUPLICATE` submissions are polled, since they may already be confirmed.

The scheduled `settlement-recovery` job checks outstanding journal entries. A
confirmed hash atomically marks the league completed and creates payouts/fees;
concurrent workers conditionally claim the league row inside the same transaction.
A transaction not yet found can replay only its identical signed envelope.
Expired or definitively failed envelopes require operator investigation; they
are never silently replaced with a newly signed payout. Completed attempts are
excluded from recovery scans. RPC outages no longer turn unknown deposits into
failed payments or mark unobservable coordinator transactions dropped.

Signed envelopes expire according to their original time bounds and do not
contain private keys. Keep journal/database access restricted as for other
financial records. This change does not migrate pre-existing unjournaled pending
settlements; reconcile those using the existing ledger tools during rollout.
