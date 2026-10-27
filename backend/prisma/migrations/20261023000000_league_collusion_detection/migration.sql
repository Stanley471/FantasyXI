-- CreateTable league_collusion_flags
CREATE TABLE "league_collusion_flags" (
    "id" TEXT NOT NULL,
    "league_id" TEXT NOT NULL,
    "account_a_id" TEXT NOT NULL,
    "squad_a_id" TEXT NOT NULL,
    "account_b_id" TEXT,
    "squad_b_id" TEXT,
    "risk_score" DOUBLE PRECISION NOT NULL,
    "confidence_level" TEXT NOT NULL,
    "suspension_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "signals_triggered" TEXT[],
    "evidence_payload" JSONB NOT NULL,
    "config_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FLAGGED',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "dismissal_reason" TEXT,
    "suspended_league_participation_at" TIMESTAMP(3),
    "suspension_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "league_collusion_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable suspension_appeals
CREATE TABLE "suspension_appeals" (
    "id" TEXT NOT NULL,
    "flag_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "appealed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suspension_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "league_collusion_flags_league_id_account_a_id_account_b_id_key" ON "league_collusion_flags"("league_id", "account_a_id", "account_b_id");

-- CreateIndex
CREATE INDEX "league_collusion_flags_league_id_status_risk_score_idx" ON "league_collusion_flags"("league_id", "status", "risk_score");

-- CreateIndex
CREATE INDEX "league_collusion_flags_league_id_account_a_id_idx" ON "league_collusion_flags"("league_id", "account_a_id");

-- CreateIndex
CREATE INDEX "league_collusion_flags_suspended_league_participation_at_idx" ON "league_collusion_flags"("suspended_league_participation_at");

-- CreateIndex
CREATE INDEX "suspension_appeals_flag_id_idx" ON "suspension_appeals"("flag_id");

-- CreateIndex
CREATE INDEX "suspension_appeals_account_id_status_idx" ON "suspension_appeals"("account_id", "status");

-- AddForeignKey
ALTER TABLE "league_collusion_flags" ADD CONSTRAINT "league_collusion_flags_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "league_collusion_flags" ADD CONSTRAINT "league_collusion_flags_account_a_id_fkey" FOREIGN KEY ("account_a_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "league_collusion_flags" ADD CONSTRAINT "league_collusion_flags_account_b_id_fkey" FOREIGN KEY ("account_b_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "league_collusion_flags" ADD CONSTRAINT "league_collusion_flags_squad_a_id_fkey" FOREIGN KEY ("squad_a_id") REFERENCES "squads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "league_collusion_flags" ADD CONSTRAINT "league_collusion_flags_squad_b_id_fkey" FOREIGN KEY ("squad_b_id") REFERENCES "squads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suspension_appeals" ADD CONSTRAINT "suspension_appeals_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "league_collusion_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suspension_appeals" ADD CONSTRAINT "suspension_appeals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
