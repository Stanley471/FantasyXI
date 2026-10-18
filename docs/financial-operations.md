# Financial Operations

## Payout dead-letter queue

Refund payouts for cancelled leagues are dispatched on-chain in batches by the
`league-refunds` job. A batch that fails, and any paid member who has no linked
Stellar wallet, is isolated in the `failed_payouts` table instead of being
retried blindly.

### Lifecycle

```
            dispatch fails
 (batch) ─────────────────► PENDING ──claim──► RETRYING ──success──► RESOLVED
                              ▲   │                 │
                              │   └──discard──►  DISCARDED
                              └──── retry fails ────┘
```

- **Isolation.** Members referenced by a `PENDING` or `RETRYING` entry are skipped by
  the automatic dispatcher until the entry is resolved. Discarding an entry is a
  write-off: its members stay excluded from automatic payouts.
- **Automatic retry, recoverable errors only.** Transient failures (RPC timeouts,
  connection resets, HTTP 429/5xx, `TRY_AGAIN_LATER`, bad sequence numbers) are retried by
  the next job run as the original batch, up to 3 attempts in total. Contract errors
  (`Error(Contract, #N)`), missing configuration, missing wallets and any
  *unknown* error need an admin.
- **No double payouts.** A retry first claims the entry with a conditional
  `PENDING → RETRYING` update, so concurrent retries (two admins, or an admin and the
  job) are rejected with `409`. Before dispatching, a retry reloads member state and
  skips anyone refunded in the meantime. An entry left in `RETRYING` for more than
  15 minutes, e.g. after a crash, can be claimed again. This is safe because the
  escrow contract ignores deposits that were already refunded.

### Admin API

All endpoints require a valid JWT. Staff (`ADMIN`, `MODERATOR`) can view entries;
only `ADMIN` can retry or discard them. The acting admin is always taken from the
token and recorded in the audit log.

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/admin/payouts/dead-letter?status=&leagueId=&type=&limit=&offset=` | ADMIN, MODERATOR | List entries |
| `GET` | `/api/v1/admin/payouts/dead-letter/:id` | ADMIN, MODERATOR | Entry details and last error |
| `POST` | `/api/v1/admin/payouts/dead-letter/:id/retry` | ADMIN | Body `{ "note"?: string }`. `200` on success, `502` if the payout rail rejects it again (the entry goes back to `PENDING`), `409` if already being retried or closed |
| `POST` | `/api/v1/admin/payouts/dead-letter/:id/discard` | ADMIN | Body `{ "reason": string }` (required). Closes the entry without paying, e.g. after a manual off-platform refund |

Typical flow for a `MISSING_WALLET` entry: ask the member to link a wallet, then retry.
The retry always uses the member's current address.

## Financial audit log

Every ledger-affecting operation is appended to `financial_audit_logs`:

| Action | Recorded by |
| --- | --- |
| `DEPOSIT_SUBMITTED`, `DEPOSIT_CONFIRMED`, `DEPOSIT_FAILED` | Payment submit / verify endpoints, Soroban event indexer |
| `WITHDRAWAL` | Prize claims picked up by the event indexer |
| `REFUND` | Refund dispatcher, admin retries, event indexer |
| `FEE_EXTRACTION` | Platform fee on league settlement (event indexer) |
| `PAYOUT_DEAD_LETTERED`, `PAYOUT_RETRY_SUCCEEDED`, `PAYOUT_RETRY_FAILED`, `PAYOUT_DISCARDED` | Dead-letter queue and admin tooling |

Each entry has a timestamp (`createdAt`), the affected `userId` (null for
platform-level operations), the `actorId` (user, admin, or `system` for workers),
`leagueId`, `amount`, `asset`, `stellarTxHash` and a JSON `metadata` object.

**Performance.** Entries are recorded only after the ledger write has committed.
`record()` never waits on the database: entries are buffered in memory and
written in batches with a single `createMany` (at least once a second, or sooner
when 100 entries are waiting). A failed write is retried. The buffer is flushed on
graceful shutdown (`SIGTERM`).

**Append-only.** The application exposes no update or delete path. Run the
following after `prisma db push` on every environment to enforce it in the
database as well (idempotent):

```bash
cd backend && npm run db:audit-guard
```

This installs triggers that reject `UPDATE`, `DELETE` and `TRUNCATE` on
`financial_audit_logs`.

**Querying.** `GET /api/v1/admin/audit/financial?userId=&leagueId=&action=&from=&to=&limit=`
(`ADMIN` only) returns entries, newest first (max 500 per request).

## Transaction coordinator

`TransactionCoordinatorService` (`backend/src/services/financial/transactionCoordinatorService.ts`) keeps watching submitted transactions after the wallet or the synchronous Soroban poll gives up.

- Every hash submitted through `POST /leagues/:leagueId/financial/submit` is tracked as a `DEPOSIT`. A settlement that was submitted but not confirmed in time is tracked as a `SETTLEMENT`.
- Each hash is a row in `coordinated_transactions`, so polling picks up again after a backend restart.
- Due rows are polled against Soroban RPC `getTransaction` with exponential backoff (`TX_COORDINATOR_*` env vars). `NOT_FOUND` and transient RPC errors mean the transaction is still pending.
- `SUCCESS` and `FAILED` are final. A hash still `NOT_FOUND` after `TX_COORDINATOR_MAX_PENDING_MS` is marked `DROPPED`, and administrators get an alert.
- Each final status is sent to:
  - the owner's notification socket (`ws(s)://<api>/api/v1/notifications/ws`; send `{ "type": "auth", "token": "<JWT>" }` as the first frame)
  - webhook endpoints subscribed to `transaction.status_changed`
  - the in-process event bus
- When a deposit succeeds, it goes through `verifyAndConfirmPayment`. A successful hash alone never marks a member as paid.
- `GET /api/v1/admin/transactions/:txHash` shows the coordinator's state for a hash.

## Ledger reconciliation

`LedgerReconciliationService` (`backend/src/services/financial/ledgerReconciliationService.ts`) checks confirmed rows in `transactions` against the escrow contract's Soroban events (`deposit`, `settle`, `refund`, `claimed`). Rows that have no event, such as classic USDC payments, are checked against Horizon transactions and operations instead.

| Type | Meaning |
| --- | --- |
| `PHANTOM_DB_RECORD` | A confirmed row whose hash is unknown to the network or failed on-chain |
| `UNINDEXED_ON_CHAIN` | An escrow event with no matching ledger row |
| `AMOUNT_MISMATCH` | Both sides exist but the amounts differ by more than the ledger's 2-decimal rounding |
| `COUNT_MISMATCH` | A refund event covers a different number of members than were marked refunded |
| `LEAGUE_MISMATCH` | The row and the event belong to different leagues |
| `DUPLICATE_DB_RECORD` | Several rows describe the same on-chain movement (critical for deposits) |
| `MISSING_CONTRACT_EVENT` | The hash succeeded on Horizon but moved no USDC and emitted no matching event |

How to run it:

- **Scheduled:** the `ledger-reconciliation` pg-boss job runs daily at 02:30 over roughly the last day of ledgers.
- **API:** `POST /api/v1/admin/reconciliation/ledger` with body `{ fromLedger?, toLedger?, lookbackLedgers? }` returns JSON. Add `?format=markdown` for Markdown. Requires `financial:reconcile`.
- **CLI:** `npm run reconcile:ledger -- [--from-ledger N] [--to-ledger N] [--lookback N] [--out DIR] [--no-notify]` writes JSON and Markdown reports. It exits with code 2 when discrepancies are found.

Every run is written to the financial audit log as `RECONCILIATION_BALANCED` or `RECONCILIATION_DISCREPANCY`. Discrepancies are also sent to `ADMIN_ALERT_SLACK_WEBHOOK_URL` and `ADMIN_ALERT_EMAILS`. The service never modifies the ledger. Soroban RPC only keeps a limited window of ledgers (often about 7 days), so older ranges are clamped to the oldest ledger still retained.

## Idempotency keys

Financial and squad mutations accept an `Idempotency-Key` header: 1-255 characters of letters, digits, `-`, `_`, `:` or `.`. Keys are scoped to the authenticated user.

| Situation | Response |
| --- | --- |
| First request | Runs normally |
| Duplicate while the first is still running | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` with `Retry-After` |
| Duplicate after it finished | The original status code and body, with `Idempotent-Replayed: true` (replayed for 24 hours) |
| Same key, different method/path/body | `422 IDEMPOTENCY_KEY_REUSED` |
| Original failed with 5xx, 408, 425 or 429, or the connection dropped | The key is released, so the retry runs again |
| Redis unreachable | `503 IDEMPOTENCY_UNAVAILABLE` (fails closed; retrying with the same key is safe) |

Records live in Redis. Each record works as a fencing-token lock that is extended while a slow request runs. When Redis is disabled, records are kept in process memory instead.

## Retroactive score corrections

`RetroactiveBpsAdjustmentService` (`backend/src/services/scoring/retroactiveBpsAdjustmentService.ts`) applies official FPL bonus and stat corrections that arrive after a gameweek has finished.

- The `retroactive-bps` job runs every 30 minutes. It compares the two most recent finished gameweeks against the FPL live endpoint.
- Only squads that own a corrected player are recalculated. Each lineup is scored with the old and the corrected stats, using the same captain, chip and auto-sub rules as normal scoring, and the difference is applied to the stored score.
- One database transaction updates:
  - the stats
  - squad gameweek scores, with an optimistic check on the previous value
  - squad totals
  - classic league totals and ranks
  - `score_adjustment_logs` rows recording previous score, delta, new score and reason
- After the commit, affected users get a `score.adjusted` notification on their notification socket.
- Leagues that are `COMPLETED`, or that already have a confirmed prize payout, are protected: their standings are never changed, and the skip is logged.
- Manual trigger: `POST /api/v1/admin/scoring/gameweeks/:gameweekId/retroactive-adjustments` with body `{ reason? }`.
