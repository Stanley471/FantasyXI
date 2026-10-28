-- CreateTable
CREATE TABLE "fpl_api_snapshots" (
    "endpoint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fpl_api_snapshots_pkey" PRIMARY KEY ("endpoint")
);
