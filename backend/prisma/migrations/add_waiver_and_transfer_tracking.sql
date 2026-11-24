-- Migration: Add waiver wire and transfer history tracking tables
-- Supports Issue #507 (Transfer History) and Issue #515 (Waiver Wire)

-- ============================================================
-- Waiver Wire Tables
-- ============================================================

-- Waiver claim submitted by a manager
CREATE TABLE IF NOT EXISTS waiver_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL,
  gameweek INTEGER NOT NULL,
  manager_id UUID NOT NULL,
  player_to_add UUID NOT NULL,
  player_to_drop UUID,
  bid_amount INTEGER NOT NULL, -- in smallest unit (cents/smallest token unit)
  status TEXT NOT NULL CHECK (status IN ('pending', 'won', 'lost', 'cancelled', 'invalid')),
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolution_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE,
  UNIQUE(league_id, gameweek, manager_id, player_to_add)
);

CREATE INDEX idx_waiver_claims_league_gameweek ON waiver_claims(league_id, gameweek);
CREATE INDEX idx_waiver_claims_manager_status ON waiver_claims(manager_id, status);

-- Escrow holds: tracks budget held for pending claims
CREATE TABLE IF NOT EXISTS escrow_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL,
  claim_id UUID NOT NULL UNIQUE,
  held_amount INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE,
  FOREIGN KEY (claim_id) REFERENCES waiver_claims(id) ON DELETE CASCADE
);

CREATE INDEX idx_escrow_holds_manager ON escrow_holds(manager_id);

-- Waiver priority per manager per league
CREATE TABLE IF NOT EXISTS waiver_priorities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL,
  manager_id UUID NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, -- 1=highest, rolling priority after win
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(league_id, manager_id),
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE
);

-- Resolution tracking (for idempotency)
CREATE TABLE IF NOT EXISTS waiver_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL,
  gameweek INTEGER NOT NULL,
  resolved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(league_id, gameweek),
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE
);

-- ============================================================
-- Transfer History Tracking
-- ============================================================

-- Transfer log per squad per gameweek
CREATE TABLE IF NOT EXISTS transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id UUID NOT NULL,
  gameweek INTEGER NOT NULL,
  player_out_id UUID NOT NULL,
  player_in_id UUID NOT NULL,
  price_out_as_integer INTEGER NOT NULL, -- in smallest unit at time of transfer
  price_in_as_integer INTEGER NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE,
  FOREIGN KEY (player_out_id) REFERENCES players(id),
  FOREIGN KEY (player_in_id) REFERENCES players(id)
);

CREATE INDEX idx_transfers_squad_gameweek ON transfers(squad_id, gameweek);
CREATE INDEX idx_transfers_timestamp ON transfers(timestamp);

-- ============================================================
-- Ownership Tracking for Waiver Wire
-- ============================================================

-- Player ownership in a league (for waiver wire free-agent tracking)
CREATE TABLE IF NOT EXISTS ownership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL,
  manager_id UUID NOT NULL,
  player_id UUID NOT NULL,
  acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  UNIQUE(league_id, manager_id, player_id)
);

CREATE INDEX idx_ownership_league_player ON ownership(league_id, player_id);

-- ============================================================
-- Budget Tracking Extensions
-- ============================================================

-- Add columns to managers table if not already present
ALTER TABLE managers
ADD COLUMN IF NOT EXISTS total_budget INTEGER DEFAULT 1000000, -- in smallest unit
ADD COLUMN IF NOT EXISTS held_budget INTEGER DEFAULT 0, -- escrow/held by waiver claims
ADD COLUMN IF NOT EXISTS free_transfers_for_gameweek INTEGER DEFAULT 1;

-- ============================================================
-- Gameweek Deadline Tracking
-- ============================================================

-- Add deadline tracking if not already in gameweeks table
ALTER TABLE gameweeks
ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'completed'));
