# FantasyXI Escrow Contract

The Soroban smart contract that holds league entry fees in escrow and pays out
prizes or refunds. It lives in [`src/lib.rs`](src/lib.rs) and is written in Rust
against `soroban-sdk` 22.0.8.

This guide walks a new contributor from a clean machine to a compiled, tested
contract and a deployment on Stellar Testnet. The commands mirror the CI
pipeline in [`.github/workflows/rust.yml`](../.github/workflows/rust.yml); if
the two ever disagree, CI is the source of truth.

- [Layout](#layout)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Test and lint](#test-and-lint)
- [Run the full CI pipeline locally](#run-the-full-ci-pipeline-locally)
- [Deploy to Stellar Testnet](#deploy-to-stellar-testnet)
- [Contract interface](#contract-interface)
- [Troubleshooting](#troubleshooting)

## Layout

```text
contracts/
├── .cargo/config.toml   # wasm32 rustflags (disables reference-types / bulk-memory)
├── Cargo.toml           # crate "fantasyxi-escrow", release profile tuned for size
├── src/lib.rs           # contract implementation + unit tests (mod test)
├── tests/               # integration, invariant and proptest suites
└── test_snapshots/      # snapshots written by soroban-sdk test environments
```

The crate is named `fantasyxi-escrow`, so the compiled artifact is
`target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm`.

## Prerequisites

| Tool | Version | Purpose |
| :--- | :--- | :--- |
| Rust (via `rustup`) | stable, 1.75+ | Compiler and Cargo |
| `wasm32-unknown-unknown` target | matches toolchain | Builds the contract Wasm |
| `rustfmt`, `clippy` | matches toolchain | Formatting and lint checks run in CI |
| `wasm-opt` (binaryen) | any recent | Post-processes the Wasm (required before tests, see below) |
| `stellar` CLI | 22+ | Key management, deployment and invocation on Testnet |

### 1. Rust toolchain and Wasm target

```bash
# Install rustup if you do not have it: https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

rustup toolchain install stable
rustup target add wasm32-unknown-unknown
rustup component add rustfmt clippy
```

### 2. Binaryen (`wasm-opt`)

```bash
# Debian / Ubuntu (what CI uses)
sudo apt-get install -y binaryen

# macOS
brew install binaryen

# Any platform with Node.js, without a system install
npm install -g binaryen
```

### 3. Stellar CLI

The Stellar CLI (`stellar`) replaces the older `soroban-cli`; its commands are
the same under the `stellar` name.

```bash
# macOS / Linux with Homebrew
brew install stellar-cli

# Or build from source with Cargo
cargo install --locked stellar-cli

stellar --version
```

## Build

All commands below are run from the `contracts/` directory.

```bash
cd contracts

# Host build (used by unit tests and clippy)
cargo build

# Contract Wasm, exactly as CI builds it
RUSTFLAGS="-C target-feature=-reference-types" \
  cargo build --target wasm32-unknown-unknown --release
```

Then post-process the Wasm with the same flags as CI:

```bash
WASM=target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm
wasm-opt -O --strip-producers \
  --enable-bulk-memory \
  --enable-sign-ext \
  --disable-reference-types \
  "$WASM" -o "$WASM"
```

> **Why the extra step?** Rust 1.82+ ships a `wasm32-unknown-unknown` standard
> library compiled with the `reference-types` feature, which the Soroban host
> in `soroban-sdk` 22 rejects. `wasm-opt --disable-reference-types` lowers it
> back out. Skipping this step makes the upgrade tests fail with
> `reference-types not enabled: zero byte expected`.

## Test and lint

Some unit tests (the `upgrade` tests) load the release Wasm from
`target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm`, so **build and
post-process the Wasm first** (see [Build](#build)), then:

```bash
# Formatting (CI fails on any diff; run `cargo fmt` to fix)
cargo fmt --check

# Lints, warnings treated as errors
cargo clippy --all-targets -- -D warnings

# Unit tests in src/lib.rs plus the suites in tests/
cargo test
```

Useful variations:

```bash
# Run a single test by name
cargo test test_deposit_and_single_settlement

# Run only one integration suite
cargo test --test invariant_tests

# Show println!/debug output from tests
cargo test -- --nocapture
```

Tests run inside the Soroban sandbox (`soroban-sdk` `testutils`): an in-memory
ledger with mock token contracts and mocked auth. They need no network access,
no Stellar account and no running node.

## Run the full CI pipeline locally

This is the exact sequence `rust.yml` runs, in order:

```bash
cd contracts
cargo fmt --check
cargo build
RUSTFLAGS="-C target-feature=-reference-types" cargo build --target wasm32-unknown-unknown --release
WASM=target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm
wasm-opt -O --strip-producers --enable-bulk-memory --enable-sign-ext --disable-reference-types "$WASM" -o "$WASM"
cargo clippy --all-targets -- -D warnings
cargo test
```

## Deploy to Stellar Testnet

The steps below deploy your own copy of the escrow to Testnet. The `testnet`
network (RPC `https://soroban-testnet.stellar.org`, passphrase
`Test SDF Network ; September 2015`) is built into the Stellar CLI.

### 1. Create and fund an admin identity

```bash
# Generates a keypair stored by the CLI and funds it with Friendbot
stellar keys generate admin --network testnet --fund

stellar keys address admin   # prints the admin G... public key
```

Never commit secret keys. `stellar keys show admin` prints the secret if you
need it for `backend/.env`.

### 2. Build the Wasm

Follow [Build](#build) (including the `wasm-opt` step).

### 3. Deploy

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm \
  --source-account admin \
  --network testnet \
  --alias fantasyxi_escrow
```

The command prints the new contract ID (`C...`). The `--alias` lets later
commands use `--id fantasyxi_escrow` in place of the full ID.

### 4. Initialize

`initialize` takes a single argument, the admin address, and can only be called
once. The admin must sign the transaction.

```bash
stellar contract invoke \
  --id fantasyxi_escrow \
  --source-account admin \
  --network testnet \
  -- initialize \
  --admin "$(stellar keys address admin)"
```

For an M-of-N admin set, call `initialize_multisig` instead (every signer must
authorize, `threshold` must be between 1 and the number of signers, max 32):

```bash
stellar contract invoke --id fantasyxi_escrow --source-account admin --network testnet \
  -- initialize_multisig \
  --signers '["GA...SIGNER1", "GB...SIGNER2", "GC...SIGNER3"]' \
  --threshold 2
```

### 5. Create a league and verify

Leagues are created per escrow partition. `asset` is the token contract the
entry fee is paid in, e.g. the USDC Stellar Asset Contract. Look up the SAC ID
for a classic asset with:

```bash
stellar contract id asset \
  --asset USDC:GC43IGCUMQYECKMRKGSJE2RPQPJ2QNHFB6VAHNNBO4NONKK3PVHEXN25 \
  --network testnet
```

Amounts are `i128` in the token's smallest unit (USDC uses 7 decimals, so
`10 USDC = 100000000`). The backend derives `league_id` from the first 16 hex
digits of the league UUID (`backend/src/services/financial/contractLeagueId.ts`).

```bash
stellar contract invoke --id fantasyxi_escrow --source-account admin --network testnet \
  -- create_league \
  --creator "$(stellar keys address admin)" \
  --league_id 1 \
  --entry_fee 100000000 \
  --asset <USDC_SAC_CONTRACT_ID>

# Read-only views (simulated, no fee)
stellar contract invoke --id fantasyxi_escrow --source-account admin --network testnet \
  -- get_league --league_id 1
stellar contract invoke --id fantasyxi_escrow --source-account admin --network testnet \
  -- is_paused_view
```

### 6. Point the apps at your contract

| File | Variable |
| :--- | :--- |
| `backend/.env` | `STELLAR_ESCROW_CONTRACT_ID`, `STELLAR_USDC_TOKEN_CONTRACT_ID` |
| `frontend/.env.local` | `NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID` |

The shared Testnet deployment used by the project is listed in the
[root README](../README.md#on-chain-infrastructure-stellar-testnet).

### Upgrading an existing deployment

```bash
# Upload the new Wasm and get its hash (does not create a new contract)
stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm \
  --source-account admin --network testnet

stellar contract invoke --id fantasyxi_escrow --source-account admin --network testnet \
  -- upgrade \
  --admin "$(stellar keys address admin)" \
  --new_wasm_hash <WASM_HASH>
```

Storage is preserved across upgrades.

## Contract interface

`src/lib.rs` is authoritative; this is a summary of the main entry points.

| Function | Who signs | Purpose |
| :--- | :--- | :--- |
| `initialize(admin)` | admin | One-time setup with a single admin |
| `initialize_multisig(signers, threshold)` | every signer | One-time setup with an M-of-N admin set |
| `create_league(creator, league_id, entry_fee, asset)` | creator | Opens an escrow partition for a league |
| `deposit(participant, league_id)` | participant | Transfers the entry fee into escrow |
| `settle(admin, league_id, winners, platform_treasury, platform_fee)` | admin | Pays winners and the platform fee, marks the league `Settled` |
| `refund(admin, league_id, participants)` | admin | Returns entry fees for a cancelled league |
| `cancel_league(caller, league_id)` | admin or league creator | Marks an unsettled league `Cancelled` |
| `claim_refund(participant, league_id)` | participant | Pulls a full refund from a cancelled league |
| `claim_prize(winner, league_id)` | winner | Pulls an allocated prize |
| `pause(admin)` / `unpause(admin)` | admin | Emergency stop for deposits and settlement |
| `upgrade(admin, new_wasm_hash)` | admin | Replaces the contract code in place |
| `get_league`, `get_deposit`, `get_prize_pool`, `is_paused_view` | none | Read-only views |

`winners` is a list of `{ winner: Address, amount: i128 }`, passed to the CLI
as JSON:

```bash
--winners '[{"winner":"GA...","amount":"570000000"},{"winner":"GB...","amount":"285000000"}]'
```

Errors are returned as `EscrowError` codes (for example `AlreadyDeposited = 6`,
`PayoutExceedsDeposits = 9`, `NotAuthorized = 10`); see the enum at the top of
`src/lib.rs` for the full list.

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| ``error[E0463]: can't find crate for `core` `` when building Wasm | `rustup target add wasm32-unknown-unknown` |
| `couldn't read .../fantasyxi_escrow.wasm` during `cargo test` / `clippy` | Build the release Wasm first (see [Build](#build)) |
| `reference-types not enabled: zero byte expected` in upgrade tests | Run the `wasm-opt --disable-reference-types` step on the Wasm |
| `cargo fmt --check` fails in CI | Run `cargo fmt` and commit the result |
| `stellar: command not found` | Install the Stellar CLI (see [Prerequisites](#prerequisites)) |
| Deploy fails with insufficient balance | Re-fund the account: `stellar keys fund admin --network testnet` |
