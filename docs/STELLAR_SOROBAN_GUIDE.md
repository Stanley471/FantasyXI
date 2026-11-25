# Stellar and Soroban Development and Testing Guide

This guide explains how FantasyXI uses Stellar and Soroban, and how to build,
test, deploy and call the escrow contract. It is written for contributors who
already know Rust and TypeScript basics but are new to Soroban.

Related documents:

- [contracts/README.md](../contracts/README.md): the contract-focused build, CI and Testnet deployment reference.
- [README.md](../README.md): project overview and the shared Testnet deployment.

Contents:

1. [Architecture](#1-architecture)
2. [Contract reference](#2-contract-reference)
3. [Tooling setup](#3-tooling-setup)
4. [Build and test the contract](#4-build-and-test-the-contract)
5. [Run a local standalone network](#5-run-a-local-standalone-network)
6. [Deploy to Testnet](#6-deploy-to-testnet)
7. [Client-side transaction assembly and wallet signing](#7-client-side-transaction-assembly-and-wallet-signing)
8. [Backend verification, reconciliation and SEP-0010 sign-in](#8-backend-verification-reconciliation-and-sep-0010-sign-in)
9. [Troubleshooting](#9-troubleshooting)

## 1. Architecture

```text
Browser (Next.js)                Backend (Express + Prisma)            Stellar
-----------------                --------------------------            -------
Wallet (Freighter, Albedo,       StellarService / SorobanContractClient   Soroban RPC
xBull, Hana, WalletConnect)      Reconciliation jobs                      Horizon
  builds + signs deposit  ---->  verifies state, settles leagues  ---->  Escrow contract (Rust)
                                                                          USDC Stellar Asset Contract
```

- **One escrow contract, many leagues.** A single deployed `FantasyXIEscrow`
  contract holds every league. Each league is a partition keyed by a `u64`
  `league_id`. The backend derives it from the first 16 hex digits of the
  league UUID (`backend/src/services/financial/contractLeagueId.ts`); the
  frontend uses the same rule in `frontend/src/lib/stellar/sorobanDeposit.ts`.
- **Entry fees are SAC tokens.** Each league stores the `asset` it was created
  with: the address of a Stellar Asset Contract (SAC), the Soroban token
  interface that wraps a classic Stellar asset such as USDC. The contract moves
  funds with `token::Client::transfer`. USDC uses 7 decimals, so amounts are
  `i128` stroops: `10 USDC = 100_000_000`.
- **Non-custodial.** Players sign their own `deposit` transactions. The backend
  signs only admin actions (settle, refund, pause) and never holds player funds.
- **Pull-based payouts.** `settle` validates the payout split, pays the
  platform fee, and records each winner's prize as claimable. Winners later call
  `claim_prize` to withdraw it. Cancelled leagues use `claim_refund` the same way.

### League lifecycle

`LeagueStatus` in `contracts/src/lib.rs`:

| Status | Meaning |
| :--- | :--- |
| `Upcoming` | Created, accepting deposits |
| `Active` | Reserved for a running league |
| `Settled` | Fee paid, prizes recorded as claimable. No further deposits or settlement |
| `Cancelled` | Participants can `claim_refund` their deposit |

Only `Upcoming` leagues accept deposits (`LeagueNotAcceptingDeposits`).
A participant can deposit once per league (`AlreadyDeposited`).

### Storage and TTL

Soroban state expires unless its time-to-live (TTL) is extended. The contract
uses these constants (in ledgers, about 5 seconds each):

| Constant | Value | Applies to |
| :--- | :--- | :--- |
| `DAY_IN_LEDGERS` | 17,280 | Unit for the values below |
| `PERSISTENT_BUMP_AMOUNT` / `INSTANCE_BUMP_AMOUNT` | 30 days | New TTL when a bump happens |
| `PERSISTENT_LIFETIME_THRESHOLD` / `INSTANCE_LIFETIME_THRESHOLD` | 14 days | A bump happens when the remaining TTL falls below this |

- **Persistent storage** holds `League`, `Deposit`, `ClaimablePrize`,
  participant pages (50 addresses per page, `PARTICIPANTS_PER_PAGE`) and similar
  per-league data. Most state-changing calls extend the entries they touch.
- **Instance storage** holds the admin, pause flag and admin configuration, and
  is extended by the same calls.
- A league nobody touches for a long time can expire. Anyone can keep one alive
  with `extend_league_ttl(league_id, threshold, extend_to)` and
  `extend_participant_page_ttl(league_id, page, threshold, extend_to)`.

## 2. Contract reference

`contracts/src/lib.rs` is authoritative. The most important entry points:

| Function | Signer | Purpose |
| :--- | :--- | :--- |
| `initialize(admin)` | admin | One-time setup |
| `initialize_multisig(signers, threshold)` | all signers | One-time M-of-N setup |
| `create_league(creator, league_id, entry_fee, asset)` | creator | Opens a league partition |
| `deposit(participant, league_id)` | participant | Transfers `entry_fee` into escrow |
| `settle(admin, league_id, winners, platform_treasury, platform_fee)` | admin | Validates payouts, pays the fee, records prizes |
| `claim_prize(winner, league_id)` | winner | Withdraws an allocated prize |
| `cancel_league(caller, league_id)` | admin or creator | Cancels an unsettled league |
| `claim_refund(participant, league_id)` | participant | Withdraws a deposit from a cancelled league |
| `pause(admin)` / `unpause(admin)` | admin | Emergency stop for deposits and settlement |
| `get_league`, `get_deposit`, `get_prize_pool`, `is_paused_view` | none | Read-only views |

Settlement rules enforced on-chain (`settle_internal`):

- `platform_fee` is at most 5% of `total_deposited` (`FeeExceedsMaxCap`).
- Payouts follow the standard curve: 1 winner takes the whole prize pool;
  2 winners split 70/30; 3 or more split 60/30/10 (extra winners receive 0). A
  tie for first place may split the first two shares equally. Anything else is
  `InvalidPrizeDistribution`.
- `fee + sum(payouts)` must equal `total_deposited` exactly (`PayoutExceedsDeposits`).
- A settled or cancelled league cannot be settled again (`AlreadySettled`).

Errors are `EscrowError` codes (for example `AlreadyDeposited = 6`,
`NotAuthorized = 10`). The frontend maps them to messages in
`sorobanDeposit.ts`.

## 3. Tooling setup

| Tool | Needed for |
| :--- | :--- |
| Rust stable plus the `wasm32-unknown-unknown` target | Building and testing the contract |
| `rustfmt`, `clippy` | CI checks |
| `wasm-opt` (binaryen) | Post-processing the Wasm (CI step) |
| Stellar CLI (`stellar`) | Keys, deploy, invoke |
| Docker | Local standalone network only |
| Node.js 20+ and npm | Backend and frontend |

```bash
rustup toolchain install stable
rustup target add wasm32-unknown-unknown
rustup component add rustfmt clippy

# Stellar CLI (pick one)
brew install stellar-cli
cargo install --locked stellar-cli

# wasm-opt (pick one)
sudo apt-get install -y binaryen
brew install binaryen
npm install -g binaryen
```

On Windows, building and testing works best from WSL2 or with the MSVC
toolchain. The GNU toolchain can fail linking the contract's `cdylib` output
with `export ordinal too large`; see [Troubleshooting](#9-troubleshooting).

## 4. Build and test the contract

All commands run from `contracts/`.

```bash
cd contracts

# Compile the contract to Wasm
cargo build --target wasm32-unknown-unknown --release
```

CI builds with extra flags and post-processes the Wasm (some unit tests load
the release Wasm, so do this before `cargo test`):

```bash
RUSTFLAGS="-C target-feature=-reference-types" \
  cargo build --target wasm32-unknown-unknown --release

WASM=target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm
wasm-opt -O --strip-producers --enable-bulk-memory --enable-sign-ext \
  --disable-reference-types "$WASM" -o "$WASM"
```

Run the tests:

```bash
cargo test                                   # unit tests plus every suite in tests/
cargo test --lib                             # unit tests in src/lib.rs only
cargo test --test property_invariants        # one integration suite
cargo test --test escrow_state_machine_invariants   # stateful proptest, 1,024 cases
```

Tests run in the in-memory Soroban sandbox (`soroban-sdk` with `testutils`):
no network, no accounts and mocked authorization.

### Test suites in `contracts/tests/`

| Suite | What it checks |
| :--- | :--- |
| `property_invariants.rs` | Conservation of funds, fee cap and payout-curve rules for one league |
| `invariant_tests.rs`, `fuzz_tests.rs`, `fuzz_emergency_refund.rs` | Invariants, fuzzed multisig and emergency-refund timelock boundaries |
| `escrow_state_machine_invariants.rs` | Random sequences of deposits, settlements, claims, cancellations and refunds checked against a reference model after every step |

The state-machine suite verifies, after every operation: contract balance equals
deposits minus claimed prizes, fees and refunds; fee plus payouts never exceed
100% of the pool; nobody deposits twice; and only winners can claim, once.

To reproduce a failing property test, proptest prints a minimal failing input
and writes a `*.proptest-regressions` file next to the test; re-running
`cargo test` replays it first.

### Lint and format (required by CI)

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

## 5. Run a local standalone network

A standalone network gives you a private ledger and a Friendbot faucet, which
is handy for iterating without Testnet rate limits.

```bash
# Start a local network with RPC and Friendbot (leave it running)
docker run --rm -p 8000:8000 --name stellar stellar/quickstart:latest --local

# Register it with the CLI
stellar network add local \
  --rpc-url http://localhost:8000/rpc \
  --network-passphrase "Standalone Network ; February 2017"

# Create and fund an identity
stellar keys generate admin --network local --fund
stellar keys address admin
```

Deploy and initialize exactly as in [section 6](#6-deploy-to-testnet), replacing
`--network testnet` with `--network local`. For a local token, create a test
asset and wrap it with `stellar contract asset deploy --asset TEST:<ISSUER> --source-account admin --network local`.

Point the backend at it with `STELLAR_NETWORK_PASSPHRASE="Standalone Network ; February 2017"`,
`STELLAR_SOROBAN_RPC_URL=http://localhost:8000/rpc` and
`STELLAR_HORIZON_URL=http://localhost:8000`.

## 6. Deploy to Testnet

Testnet is built into the CLI (RPC `https://soroban-testnet.stellar.org`,
passphrase `Test SDF Network ; September 2015`).

```bash
# 1. Identity funded by Friendbot
stellar keys generate admin --network testnet --fund

# 2. Deploy the Wasm built in section 4
cd contracts
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm \
  --source-account admin --network testnet --alias fantasyxi_escrow

# 3. One-time initialization
stellar contract invoke --id fantasyxi_escrow --source-account admin --network testnet \
  -- initialize --admin "$(stellar keys address admin)"

# 4. Find the USDC token contract (SAC) for the classic asset
stellar contract id asset \
  --asset USDC:GC43IGCUMQYECKMRKGSJE2RPQPJ2QNHFB6VAHNNBO4NONKK3PVHEXN25 \
  --network testnet

# 5. Create a league (entry fee 10 USDC) and read it back
stellar contract invoke --id fantasyxi_escrow --source-account admin --network testnet \
  -- create_league --creator "$(stellar keys address admin)" \
  --league_id 1 --entry_fee 100000000 --asset <USDC_SAC_CONTRACT_ID>
stellar contract invoke --id fantasyxi_escrow --source-account admin --network testnet \
  -- get_league --league_id 1
```

Never commit secret keys; keep them in `backend/.env` (ignored by git).
Set `STELLAR_ESCROW_CONTRACT_ID` in `backend/.env` and
`NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID` in `frontend/.env.local`.

## 7. Client-side transaction assembly and wallet signing

A deposit never touches the backend's keys. `depositToSorobanEscrow` in
`frontend/src/lib/stellar/sorobanDeposit.ts` runs this pipeline:

1. **Load the account.** `rpc.Server.getAccount(publicKey)` fetches the sequence
   number. The account must exist and hold XLM for fees.
2. **Build the invocation.** `new Contract(escrowContractId).call("deposit",
   new Address(publicKey).toScVal(), nativeToScVal(leagueId, { type: "u64" }))`
   becomes the single operation of a `TransactionBuilder` transaction with a
   180-second timeout.
3. **Simulate and prepare.** `server.prepareTransaction(tx)` simulates the call,
   attaches the resource footprint, Soroban authorization entries and the
   resource fee. Contract errors surface here as `Error(Contract, #N)` and are
   translated into user messages.
4. **Sign with the wallet.** The prepared XDR is passed to the wallet's
   `signTransaction(xdr, { networkPassphrase, address })`. Wallets are managed by
   `StellarWalletsKit` in `frontend/src/context/WalletContext.tsx`
   (`useWallet()` exposes `publicKey`, `connect` and `signTransaction`). The
   signer receives and returns XDR strings only; the private key never leaves
   the wallet.
5. **Submit and confirm.** The signed XDR is sent with `sendTransaction`, then
   polled with `getTransaction` until it is `SUCCESS` or `FAILED`. A timeout
   raises `SorobanDepositTimeoutError` carrying the hash so the UI can retry the
   status check.
6. **Tell the backend.** The UI posts the transaction hash to
   `POST /api/v1/leagues/:id/submit-payment`; the backend independently verifies
   it on-chain before marking the member paid.

The same `WalletTransactionSigner` type is used for **wallet sign-in**
(SEP-0010): the login page asks the backend for a challenge transaction, the
wallet signs it, and nothing is ever submitted to the network.

## 8. Backend verification, reconciliation and SEP-0010 sign-in

- `StellarService` and `SorobanContractClient`
  (`backend/src/services/financial/`) read contract state (`getLeague`,
  deposits, token balance) and submit admin transactions.
- **Reconciliation.** `backend/src/jobs/stellarReconciliation.ts` runs every 6
  hours. For each active paid league it compares
  `sum(confirmed entry fees) - (prize payouts + refunds)` from the database with
  the escrow's `total_deposited`, to the stroop. Any mismatch raises a critical
  admin alert and writes a flagged `RECONCILIATION_DISCREPANCY` entry to the
  financial audit log. It also checks that the contract's token balance covers
  the leagues it verified. It is read-only and never moves funds.
- **SEP-0010 sign-in.** `GET /api/v1/auth/stellar/challenge?account=G...`
  returns a server-signed challenge; `POST /api/v1/auth/stellar/verify` accepts
  the wallet-signed challenge and returns a normal session. Configure
  `SEP10_SERVER_SIGNING_KEY` (a dedicated account that holds no funds) in
  `backend/.env`; see `backend/.env.example`. Only accounts with a linked wallet
  can sign in this way.

Backend tests that cover these paths:

```bash
cd backend
npm ci
npx prisma generate
npx tsx --test src/tests/stellarReconciliation.test.ts src/tests/stellarAuth.test.ts
```

## 9. Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| ``can't find crate for `core` `` building Wasm | `rustup target add wasm32-unknown-unknown` |
| `couldn't read .../fantasyxi_escrow.wasm` during `cargo test` | Build the release Wasm first (section 4) |
| `reference-types not enabled: zero byte expected` | Run the `wasm-opt --disable-reference-types` step |
| `export ordinal too large` linking on Windows (GNU toolchain) | Use WSL2 or the MSVC toolchain, or build with a temporary `crate-type = ["rlib"]` (do not commit it) |
| `Error(Contract, #6)` on deposit | `AlreadyDeposited`: the account already joined this league |
| Deposit simulation fails with a balance error | Fund the account with XLM and add a USDC trustline |
| `Stellar sign-in is not configured on this server` (503) | Set `SEP10_SERVER_SIGNING_KEY` in `backend/.env` |
