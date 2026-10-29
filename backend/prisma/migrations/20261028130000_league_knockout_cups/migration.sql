-- Knockout cup fixtures (issue #231).
ALTER TABLE "league_fixtures"
  ADD COLUMN "is_cup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "winner_member_id" TEXT,
  ADD COLUMN "tiebreak_reason" TEXT;

-- A manager can have a league fixture and a cup fixture in the same gameweek.
DROP INDEX IF EXISTS "league_fixtures_league_id_gameweek_id_home_member_id_key";
CREATE UNIQUE INDEX "league_fixtures_league_id_gameweek_id_home_member_id_is_cup_key"
  ON "league_fixtures"("league_id", "gameweek_id", "home_member_id", "is_cup");

CREATE INDEX "league_fixtures_league_id_is_cup_playoff_round_idx"
  ON "league_fixtures"("league_id", "is_cup", "playoff_round");
