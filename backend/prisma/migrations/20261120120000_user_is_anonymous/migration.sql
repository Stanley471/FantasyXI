-- Anonymous leaderboard display (issue #511).
ALTER TABLE "users" ADD COLUMN "is_anonymous" BOOLEAN NOT NULL DEFAULT false;
