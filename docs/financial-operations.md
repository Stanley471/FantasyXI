# Financial Operations: Payout Dead-Letter Queue & Audit Log

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
