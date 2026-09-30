-- CS2 Inventory Simulator — D1 (SQLite) migration 0002.
-- Token-bucket storage for public (apiKey-less) calls to
-- /api/increment-item-stattrak and /api/consume-item-spray; mirrors the
-- upstream Prisma model RateLimitBucket (api/models/rate-limit.server.ts).

CREATE TABLE "RateLimitBucket" (
  "key" TEXT PRIMARY KEY,
  "tokens" REAL NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
