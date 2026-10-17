-- Declarative PostgreSQL range partitioning for high-velocity real-time match event logs (#263)

CREATE TABLE IF NOT EXISTS live_match_events (
    id UUID NOT NULL,
    fixture_id INTEGER NOT NULL,
    gameweek_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    points_delta INTEGER NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_live_match_events_gw_created
    ON live_match_events (gameweek_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_match_events_player_created
    ON live_match_events (player_id, created_at DESC);

-- Default safety partition so out-of-range inserts never fail even if cron rotation is delayed
CREATE TABLE IF NOT EXISTS live_match_events_default
    PARTITION OF live_match_events DEFAULT;
