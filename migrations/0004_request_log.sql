-- CS2 Inventory Simulator — D1 (SQLite) migration 0004.
-- Per-request API call log for the admin dashboard.
--
-- Every request that reaches the Worker is recorded here (method, path,
-- status, timestamp). The dashboard aggregates it into per-route call counts
-- and per-day volumes. The table is append-only; old rows can be purged with
-- a plain DELETE when it grows too large (no foreign key on userId because
-- anonymous requests have no user).

CREATE TABLE "RequestLog" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "method" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "status" INTEGER NOT NULL,
  "userId" TEXT,
  "createdAt" INTEGER NOT NULL
);

CREATE INDEX "RequestLog_createdAt_idx" ON "RequestLog" ("createdAt");