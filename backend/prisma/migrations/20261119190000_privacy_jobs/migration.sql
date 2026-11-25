CREATE TABLE privacy_jobs (
  id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('EXPORT','ERASE')),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','DONE','FAILED')),
  public_key text, object_key text,
  attempts integer NOT NULL DEFAULT 0, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX privacy_jobs_owner ON privacy_jobs(user_id,created_at DESC);
CREATE INDEX privacy_jobs_pending ON privacy_jobs(status,updated_at);
CREATE TABLE privacy_erased_accounts (
  user_id text PRIMARY KEY REFERENCES users(id), erased_at timestamptz NOT NULL DEFAULT now()
);
