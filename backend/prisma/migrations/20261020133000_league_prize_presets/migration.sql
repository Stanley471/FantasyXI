ALTER TABLE "leagues"
  ADD COLUMN "payout_preset" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "payout_splits_bps" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
