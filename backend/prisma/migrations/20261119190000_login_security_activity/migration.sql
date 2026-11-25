CREATE TABLE login_security_activity (
  id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip text NOT NULL, browser text NOT NULL, device text NOT NULL,
  latitude double precision, longitude double precision, asn text,
  outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_security_activity_owner_time ON login_security_activity(user_id,created_at DESC);
CREATE TABLE login_trusted_locations (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  latitude double precision NOT NULL, longitude double precision NOT NULL,
  verified_at timestamptz NOT NULL, PRIMARY KEY(user_id,latitude,longitude)
);
