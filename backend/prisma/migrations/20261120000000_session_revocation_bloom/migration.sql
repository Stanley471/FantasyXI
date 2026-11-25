CREATE TABLE "revoked_sessions" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "user_id" TEXT,
  "reason" TEXT,
  "revoked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "revoked_sessions_session_id_key" ON "revoked_sessions"("session_id");
CREATE INDEX "revoked_sessions_expires_at_idx" ON "revoked_sessions"("expires_at");
