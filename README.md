# FantasyXI: Decentralized Fantasy Football on Stellar & Soroban

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16.3.4-black.svg)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.x-61dafb.svg)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-5.2.1-lightgrey.svg)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-7.10.0-2D3748.svg)](https://www.prisma.io/)
[![Stellar](https://img.shields.io/badge/Stellar-Testnet-08B5E5.svg)](https://stellar.org/)
[![Soroban](https://img.shields.io/badge/Soroban-v22.0.8-7D3C98.svg)](https://soroban.stellar.org/)
[![License](https://img.shields.io/badge/License-ISC-green.svg)](LICENSE)

FantasyXI is an open-source, non-custodial fantasy football platform built on **Stellar Testnet** and **Soroban smart contracts**, integrated with live **Fantasy Premier League (FPL)** data. 

Managers assemble squads, compete in custom multi-gameweek leagues, and deposit entry fees directly into a trustless Soroban escrow smart contract. When competition concludes, prize pools (95% distributed 60/30/10 with a 5% platform fee) are settled and disbursed directly on-chain with zero counterparty risk and zero lost cents.

---

## Architecture Overview

```mermaid
flowchart TB
    subgraph Client Layer
        Browser[User Browser / Next.js 16 UI]
        Freighter[Freighter Wallet Extension]
    end

    subgraph Backend Application Layer [Express 5 + TypeScript]
        AuthSvc[Auth Service: Email/Pass + Google OAuth]
        SquadSvc[Squad Validator & Formations]
        LeagueSvc[League & Competition Engine]
        FplSvc[FPL Upstream Sync & Normalizer]
        FinSvc[Financial State Machine & Accounting]
        StellarSvc[Stellar & Soroban Verifier Service]
    end

    subgraph Data Layer
        PostgreSQL[(PostgreSQL + Prisma 7)]
        FPL_API[FPL Official Upstream API]
    end

    subgraph Blockchain Layer [Stellar Testnet]
        Horizon[Stellar Horizon API]
        SorobanRPC[Soroban RPC Node]
        EscrowContract[FantasyXI Escrow Smart Contract\nCB4KIK42P32SZHKG...]
        UsdcSAC[USDC Stellar Asset Contract\nCBKWOGJ7CQSVZXIO...]
    end

    Browser -->|JWT Authenticated API Calls| AuthSvc
    Browser -->|Squad Selection & Joins| SquadSvc
    Browser -->|Freighter Signs invokeHostFunction| Freighter
    Freighter -->|Direct Soroban Invocation: deposit()| EscrowContract
    
    FinSvc --> StellarSvc
    StellarSvc -->|Verify Envelope XDR & Status| Horizon
    StellarSvc -->|Verify On-Chain Ledger State| SorobanRPC

    LeagueSvc --> PostgreSQL
    SquadSvc --> PostgreSQL
    FinSvc --> PostgreSQL
    FplSvc -->|Sync Players & Fixtures| FPL_API
    FplSvc --> PostgreSQL

    EscrowContract -->|Transfer USDC| UsdcSAC
```

### Architectural Separation of Concerns

FantasyXI enforces a strict boundary between Web2 application gameplay and Web3 financial settlements:

1. **Express Owns Game Logic**:
   - User profiles and JWT authentication (Email/Password + Google OAuth 2.0).
   - Squad assembly (15 players, £100m budget, formation rules, captains, vice-captains).
   - Live FPL points aggregation, bonus calculations, and auto-substitutions.
   - League standings, multi-gameweek aggregations, and deterministic tie-breaking.
2. **Soroban Owns Financial Escrow**:
   - Escrow contract manages league partitions identified by `league_id`.
   - Direct USDC SAC transfers from participants into contract storage.
   - Enforces atomic invariant guards: `AlreadyDeposited`, `PayoutExceedsDeposits`, `AlreadySettled`, and `NotAuthorized`.
   - Admin triggers automated on-chain settlement (`settle`) or full refund (`refund`).
3. **No Web3 Authentication Requirement**:
   - Users do **not** sign in using Stellar keypairs.
   - Freighter wallet is invoked **strictly** when signing financial transactions (`deposit`).

---

## On-Chain Infrastructure (Stellar Testnet)

| Component | Identifier / Address |
| :--- | :--- |
| **Escrow Smart Contract** | [`CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA`](https://stellar.expert/explorer/testnet/contract/CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA) |
| **USDC Stellar Asset Contract (SAC)** | [`CBKWOGJ7CQSVZXIOIIPCDAUT6APQYBCEE7QTSGDZZ2RO6D3JYRMKWZNG`](https://stellar.expert/explorer/testnet/contract/CBKWOGJ7CQSVZXIOIIPCDAUT6APQYBCEE7QTSGDZZ2RO6D3JYRMKWZNG) |
| **USDC Classic Asset Issuer** | `GC43IGCUMQYECKMRKGSJE2RPQPJ2QNHFB6VAHNNBO4NONKK3PVHEXN25` |
| **Network Passphrase** | `Test SDF Network ; September 2015` |
| **Soroban RPC Server** | `https://soroban-testnet.stellar.org` |
| **Horizon API Server** | `https://horizon-testnet.stellar.org` |

---

## Core Subsystems

### 1. Fantasy Football Engine
- **Squad Requirements**: Exactly 15 players (2 Goalkeepers, 5 Defenders, 5 Midfielders, 3 Forwards).
- **Budgetary Constraints**: Total squad cost must not exceed **£100.0m**.
- **Club Limits**: Maximum of 3 players from any single Premier League club.
- **Formations**: Supports standard tactical layouts (e.g., `4-4-2`, `3-5-2`, `3-4-3`, `5-3-2`, `4-3-3`, `5-4-1`) with a minimum of 1 GKP, 3 DEF, 2 MID, 1 FWD starting.
- **Multipliers & Substitutions**:
  - Captain scores **2x points**; if the captain plays 0 minutes, the 2x multiplier dynamically transfers to the Vice-Captain.
  - Automatic bench substitutions prioritize the highest-priority eligible bench player while maintaining formation validity.

### 2. League Competition Engine
- **Lifecycle Transitions**: `UPCOMING` $\to$ `ACTIVE` $\to$ `COMPLETED` or `CANCELLED`.
- **Standings & Tie-Breaking**:
  1. Primary: Cumulative fantasy points across all competition gameweeks.
  2. Secondary (Tie-break 1): Peak single-gameweek score within the league window.
  3. Tertiary (Tie-break 2): Earliest registration timestamp (deterministic resolution).

### 3. Soroban Escrow Smart Contract (`contracts/src/lib.rs`)
Written in Rust using the Soroban SDK (`soroban-sdk = "22.0.8"`), exposing 7 contract functions:
- `initialize(admin, usdc_token)`: One-time contract initialization.
- `create_league(creator, league_id, entry_fee)`: Partitions an isolated league escrow.
- `deposit(participant, league_id)`: Transfers `entry_fee` from participant via USDC SAC client into contract storage. Requires `participant.require_auth()`.
- `settle(admin, league_id, winners, platform_treasury, platform_fee)`: Distributes prize pool to top 3 winners and platform treasury. Enforces `PayoutExceedsDeposits` and transitions status to `Settled` atomically.
- `refund(admin, league_id, participants)`: Refunds entry fees to participants in cancelled competitions.
- `get_league(league_id)`: View function returning on-chain state (`creator`, `entry_fee`, `total_deposited`, `participant_count`, `status`).
- `get_deposit(league_id, participant)`: View function returning participant deposit amount.

### 4. Deterministic Prize Distribution (Zero Lost Cents)
Managed by `PrizeService`:
- **Platform Fee**: Flat 5% deducted from gross prize pool.
- **Prize Pool (95%)**:
  - **1st Place**: 60% of net prize pool
  - **2nd Place**: 30% of net prize pool
  - **3rd Place**: 10% of net prize pool
  - *(2-player leagues split 70% / 30%; 1-player leagues refund 100%)*
- Uses integer stroop rounding to ensure zero dropped fractions or orphaned tokens.

---

## Repository Structure

```text
FantasyXI/
├── backend/                   # Node.js + Express + TypeScript Backend
│   ├── prisma/
│   │   ├── schema.prisma      # PostgreSQL schema & enum definitions
│   ├── src/
│   │   ├── config/            # Database, Stellar, JWT, and CORS configuration
│   │   ├── controllers/       # HTTP Request handlers (Auth, League, Squad, Financial)
│   │   ├── middleware/        # JWT Authentication & authorization guards
│   │   ├── routes/            # Express v5 API routes (/api/v1/...)
│   │   ├── services/
│   │   │   ├── financial/     # FinancialService, StellarService, SorobanContractClient
│   │   │   ├── fpl/           # Upstream FPL synchronization & normalization
│   │   │   └── league/        # LeagueService, SquadValidator, ScoringService, PrizeService
│   │   ├── scripts/           # Phase 7.6 Live Stellar Testnet verification scripts
│   │   └── tests/             # Comprehensive unit & integration test suites
│   ├── package.json           # Scripts & backend dependencies
│   └── tsconfig.json          # NodeNext strict TypeScript configuration
├── frontend/                  # Next.js 16 + React 19 + TailwindCSS App
│   ├── src/
│   │   ├── app/               # App Router pages (leagues, fixtures, team, profile, etc.)
│   │   ├── components/        # UI components, Pitch visualizer, PlayerCard, PaymentModal
│   │   ├── context/           # AuthContext (JWT session management)
│   │   └── lib/
│   │       ├── api.ts         # Axios/Fetch API client wrapper
│   │       └── stellar/       # sorobanDeposit.ts (Freighter + Soroban RPC client)
│   ├── package.json           # Frontend dependencies (@stellar/freighter-api, @stellar/stellar-sdk)
│   └── next.config.ts         # Next.js configuration (Turbopack)
├── contracts/                 # Soroban Escrow Smart Contract (Rust)
│   ├── src/
│   │   └── lib.rs             # Escrow contract implementation & Rust unit tests
│   └── Cargo.toml             # Rust package configuration (soroban-sdk = "22.0.8")
├── tools/                     # Local developer tooling (Stellar CLI binaries)
└── REGULATORY_CONSIDERATIONS.md # Legal, AML, and non-custodial compliance documentation
```

---

## Local Development Setup

### Prerequisites
- **Node.js**: v20.x or v24.x
- **Rust**: `1.75.0+` with target `wasm32-unknown-unknown`
- **PostgreSQL**: `v14+` running locally or via Docker
- **Stellar CLI**: `v22+` installed for contract simulation / execution
- **Freighter Wallet Extension**: Installed in your browser (configured to Stellar Testnet)

### 1. Database Setup
Ensure PostgreSQL is running and create a local database:
```sql
CREATE DATABASE fantasyxi;
```

### 2. Backend Setup
Navigate to `backend/` and create your `.env` file:
```bash
cd backend
cp .env.example .env
```

Configure `backend/.env`:
```env
PORT=5000
NODE_ENV=development
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fantasyxi?schema=public"
JWT_SECRET="your-secure-jwt-secret-key-at-least-32-chars"
JWT_EXPIRES_IN="7d"

# Stellar Testnet Configuration
STELLAR_NETWORK=TESTNET
STELLAR_HORIZON_URL="https://horizon-testnet.stellar.org"
STELLAR_SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
STELLAR_USDC_ASSET_CODE="USDC"
STELLAR_USDC_ISSUER="GC43IGCUMQYECKMRKGSJE2RPQPJ2QNHFB6VAHNNBO4NONKK3PVHEXN25"
STELLAR_USDC_TOKEN_CONTRACT_ID="CBKWOGJ7CQSVZXIOIIPCDAUT6APQYBCEE7QTSGDZZ2RO6D3JYRMKWZNG"
STELLAR_ESCROW_CONTRACT_ID="CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA"
STELLAR_TREASURY_ADDRESS="GC43IGCUMQYECKMRKGSJE2RPQPJ2QNHFB6VAHNNBO4NONKK3PVHEXN25"
```

Install dependencies, run database migrations, and generate Prisma client:
```bash
npm install
npm run db:migrate
npm run build
```

Start the backend development server:
```bash
npm run dev
```
Backend API will be running at `http://localhost:5000`.

### 3. Frontend Setup
Navigate to `frontend/`:
```bash
cd ../frontend
cp .env.example .env.local
```

Configure `frontend/.env.local`:
```env
NEXT_PUBLIC_API_URL="http://localhost:5000"
NEXT_PUBLIC_STELLAR_NETWORK="TESTNET"
NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID="CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA"
NEXT_PUBLIC_STELLAR_SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

Install dependencies and start Next.js:
```bash
npm install
npm run dev
```
Frontend will be accessible at `http://localhost:3000`.

---

## Testing & Quality Assurance

FantasyXI maintains automated test suites across all architectural layers.

### 1. Backend Automated Unit Tests (118 Tests)
Executes domain rules, scoring, formation constraints, tie-breakers, auth, and payment envelope parsing without live network dependencies:
```bash
cd backend
npm test
```
**Output**: `118 passed, 0 failed across 33 suites`

### 2. Smart Contract Tests (6 Tests)
Executes contract unit tests and invariant checks inside the Soroban simulation environment:
```bash
cd contracts
cargo test
```
**Output**: `6 passed, 0 failed`
- `test_initialize_and_create_league`: Validates partition initialization.
- `test_deposit_and_single_settlement`: Proves 95/5 payout mechanics.
- `test_duplicate_deposit_rejected`: Reverts with `AlreadyDeposited` (#6).
- `test_settlement_payout_exceeding_deposits_rejected`: Reverts with `PayoutExceedsDeposits` (#9).
- `test_unauthorized_settlement_rejected`: Reverts with `NotAuthorized` (#10).
- `test_refund_cancelled_league`: Proves complete token return upon cancellation.

### 3. Live Stellar Testnet E2E Lifecycle Proof
Executes a live on-chain competition (`create_league`, multi-manager `deposit`, envelope verification, guard assertions, and `settle`) against Stellar Testnet:
```bash
cd backend
npx tsx src/scripts/provePhase76Lifecycle.ts
```
Results are saved to `backend/phase7.6_testnet_evidence.json`.

### 4. Frontend Production Build
Verifies strict TypeScript compliance and static page optimization:
```bash
cd frontend
npm run build
```
**Output**: `13/13 static & dynamic routes compiled with zero errors`.

### 5. Progressive Web App (Offline Mode)
The frontend installs as a PWA (manifest + service worker in `frontend/public/`). The service worker is only registered in production builds:
```bash
cd frontend
npm run build && npm start
```
- Open the app once online and sign in; the squad page and its assets are cached at install, and each successful squad load saves a per-user snapshot on the device.
- In DevTools > Application, check the manifest and service worker, then tick **Network > Offline** and reload `/team`: the squad is shown read-only with an offline banner. Uncached pages fall back to `/offline.html`.
- Saving the squad and transfers always require a connection. Authenticated API responses are never stored in the shared service worker cache, and offline snapshots are cleared on sign-out.

---

## Production Deployment Guide

### Deploying the Backend on Render
1. Create a **Web Service** on [Render](https://render.com).
2. Connect your repository and configure:
   - **Root Directory**: `backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start` *(Runs compiled code via `node dist/server.js` without dev tooling)*
3. Add Environment Variables:
   - `DATABASE_URL`: Hosted PostgreSQL connection string.
   - `JWT_SECRET`: Random 64-character secret.
   - `NODE_ENV`: `production`
   - Plus all `STELLAR_*` configuration parameters.

### Deploying the Frontend on Vercel / Render
1. Create a **Frontend Project** pointing to `frontend/`.
2. Configure build settings:
   - **Framework Preset**: `Next.js`
   - **Build Command**: `npm run build`
   - **Output Directory**: `.next`
3. Add Environment Variables:
   - `NEXT_PUBLIC_API_URL`: URL of your deployed backend.
   - `NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID`: `CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA`

---

## Security & Regulatory Compliance

- **Non-Custodial Architecture**: FantasyXI never takes possession or custody of user stablecoins. Funds reside exclusively in the open-source Soroban smart contract escrow partition until settlement.
- **Envelope XDR Verification**: Payments are verified on-chain by decoding `invokeHostFunction` transaction envelopes, matching contract ID, function call, sender public key, and league ID.
- **SQL & Injection Protection**: Database interactions are performed using Prisma ORM with parameterized queries.
- **Rate Limiting & Authentication**: Endpoints requiring user context are guarded by JWT authorization middleware with CSRF-protected OAuth state tokens.
- Consult [`REGULATORY_CONSIDERATIONS.md`](file:///c:/ReactApps/FantasyXI/REGULATORY_CONSIDERATIONS.md) for legal classifications, skill-game exemptions, and AML operational considerations.

---

## License

This project is licensed under the **ISC License**. See the `LICENSE` file for details.
