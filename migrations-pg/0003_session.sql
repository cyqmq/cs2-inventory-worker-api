-- CS2 Inventory Simulator — PostgreSQL (Hyperdrive) migration 0003.
-- Mirrors migrations/0003_session.sql; see that file for the rationale.

CREATE TABLE "Session" (
  "sid" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "createdAt" DOUBLE PRECISION NOT NULL,
  "expiresAt" DOUBLE PRECISION NOT NULL,
  "revokedAt" DOUBLE PRECISION,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX "Session_userId_idx" ON "Session" ("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session" ("expiresAt");
