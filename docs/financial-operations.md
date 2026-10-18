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

## Treasury withdrawal timelock

Platform-fee treasury withdrawals go through `TreasuryTimelockService`
(`backend/src/services/financial/treasuryTimelockService.ts`) so that no single
compromised key can move funds.

### Lifecycle

```
PENDING_APPROVAL ──(M of N admin signatures)──▶ QUEUED ──(48h elapsed)──▶ EXECUTING ──▶ EXECUTED
       │                                           │                          │
       └──────────────── CANCELLED ◀───────────────┘                          └─(submit fails)─▶ QUEUED
       └── EXPIRED (threshold not met within 7 days, or not executed within 7 days of unlocking)
```

1. **Propose.** Any administrator creates a proposal (destination, amount,
   asset, optional memo). Proposing moves no funds.
2. **Approve.** Each administrator signs the proposal digest with their Stellar
   key (`signWithdrawalAction(proposal, "APPROVE", keypair, networkPassphrase)`).
   The digest covers the immutable proposal fields, the action and the network
   passphrase, so a signature cannot be replayed for another proposal, action or
   network. Duplicate approvals, keys outside the administrator set and invalid
   Ed25519 signatures are rejected. The threshold must be at least 2.
3. **Timelock.** The 48-hour timelock starts when the M-th approval arrives.
   Execution is refused before `executableAt`. The timelock cannot be configured
   below 48 hours.
4. **Cancel.** Any administrator can cancel a pending or queued withdrawal with
   a signed `CANCEL` action until it executes.
5. **Execute.** An administrator signs `EXECUTE`. Stored approvals are
   re-verified first, then `StellarTreasuryWithdrawalExecutor` builds the
   payment, signs it through the configured `StellarTransactionSigner`
   (local secret or KMS/HSM) and submits it to Horizon.

Every accepted signature, state change and rejected attempt (with its reason)
is appended to the `CryptographicAuditLog` hash chain.

Proposals are held by a pluggable `TreasuryProposalStore`; the default store is
in memory, so a restart drops pending proposals (fail-safe: nothing executes).
