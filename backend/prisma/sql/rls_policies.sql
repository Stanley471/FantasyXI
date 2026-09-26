-- PostgreSQL Row Level Security (RLS) policies for multi-tenant isolation
--
-- These policies ensure that users can only access data belonging to their
-- leagues. Application-level checks are still required, but RLS provides
-- a database-level safety net against accidental cross-tenant access.
--
-- Run this migration after the schema is created:
--   psql -f prisma/sql/rls_policies.sql <database_url>

-- ============================================================
-- leagues: users can read leagues they created or are members of
-- ============================================================
ALTER TABLE leagues ENABLE ROW LEVEL SECURITY;

CREATE POLICY league_isolation ON leagues
  FOR ALL
  USING (
    creator_id = current_setting('app.current_user_id', true)
    OR id IN (
      SELECT league_id FROM league_members
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- league_members: users can read/write memberships in their leagues
-- ============================================================
ALTER TABLE league_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY league_member_isolation ON league_members
  FOR ALL
  USING (
    user_id = current_setting('app.current_user_id', true)
    OR league_id IN (
      SELECT league_id FROM league_members
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- transactions: users can read transactions for their leagues/squads
-- ============================================================
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY transaction_isolation ON transactions
  FOR ALL
  USING (
    user_id = current_setting('app.current_user_id', true)
    OR league_id IN (
      SELECT league_id FROM league_members
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- squads: users can only access their own squads
-- ============================================================
ALTER TABLE squads ENABLE ROW LEVEL SECURITY;

CREATE POLICY squad_isolation ON squads
  FOR ALL
  USING (
    user_id = current_setting('app.current_user_id', true)
  );

-- ============================================================
-- squad_players: users can only access players in their own squads
-- ============================================================
ALTER TABLE squad_players ENABLE ROW LEVEL SECURITY;

CREATE POLICY squad_player_isolation ON squad_players
  FOR ALL
  USING (
    squad_id IN (
      SELECT id FROM squads
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- league_fixtures: users can access fixtures for their leagues
-- ============================================================
ALTER TABLE league_fixtures ENABLE ROW LEVEL SECURITY;

CREATE POLICY league_fixture_isolation ON league_fixtures
  FOR ALL
  USING (
    league_id IN (
      SELECT league_id FROM league_members
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- league_invitations: users can access invitations for their leagues
-- ============================================================
ALTER TABLE league_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY league_invitation_isolation ON league_invitations
  FOR ALL
  USING (
    league_id IN (
      SELECT league_id FROM league_members
      WHERE user_id = current_setting('app.current_user_id', true)
    )
  );

-- ============================================================
-- Helper function to set the current user context
-- ============================================================
CREATE OR REPLACE FUNCTION set_rls_context(user_id TEXT)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.current_user_id', user_id, true);
END;
$$ LANGUAGE plpgsql;
