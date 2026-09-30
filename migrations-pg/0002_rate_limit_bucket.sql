-- CS2 Inventory Simulator — PostgreSQL (Hyperdrive) migration 0002.
-- Mirrors migrations/0002_rate_limit_bucket.sql and the upstream Prisma model
-- RateLimitBucket (api/models/rate-limit.server.ts).

CREATE TABLE "RateLimitBucket" (
  "key" TEXT PRIMARY KEY,
  "tokens" DOUBLE PRECISION NOT NULL,
  "updatedAt" DOUBLE PRECISION NOT NULL
);
