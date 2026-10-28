# Soroban transaction replay

State-changing contract calls persist their signed XDR envelope, hash, source
account, and sequence in `soroban_transaction_submissions` before contacting
Soroban RPC. The API process performs a short confirmation poll; the background
replay daemon continues polling due submissions and rebroadcasts the exact same
envelope with capped exponential backoff.

Statuses are `PENDING_VERIFICATION`, `SUBMITTED`, `SUCCESS`, `FAILED`, and
`DROPPED`. Each status change is appended to
`soroban_transaction_transitions`. A transaction is marked `SUCCESS` only after
Soroban RPC reports ledger inclusion, at which point any matching financial
ledger rows are updated to `CONFIRMED` with the ledger sequence. `FAILED` is
used only for a transaction reported failed in a finalized ledger.

`NOT_FOUND` alone is not proof of a drop. The daemon marks a transaction
`DROPPED` only when the latest ledger close time is past its signed time bound
and the source account sequence proves that this sequence has not been
consumed. If the sequence may have been consumed while the hash is not
available, the submission remains pending verification.

The queue never stores signing secrets. For a verified drop, the result tells
the caller to submit a newly signed transaction. The client obtains the
account's current sequence before building that transaction; the old signed
envelope is never modified or assigned a new sequence. Exact-envelope replay
is idempotent and cannot create multiple transactions from the same signature.

The replay daemon starts with the PostgreSQL-backed job queue and stops with
it. Set `SOROBAN_REPLAY_POLL_MS` to adjust the daemon's idle polling interval
(default 2000 ms). Applying the updated Prisma schema is required before
deploying.
