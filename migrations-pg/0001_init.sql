-- CS2 Inventory Simulator — PostgreSQL schema (Hyperdrive).
-- Timestamps are stored as DOUBLE PRECISION (unix epoch milliseconds, JS number).
-- Mirrors migrations/0001_init.sql + prisma/schema.prisma from the original server.

CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY,
  "avatar" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "inventory" TEXT,
  "inventoryVersion" INTEGER NOT NULL DEFAULT 0,
  "lastSeen" DOUBLE PRECISION NOT NULL,
  "syncedAt" DOUBLE PRECISION NOT NULL,
  "createdAt" DOUBLE PRECISION NOT NULL,
  "updatedAt" DOUBLE PRECISION NOT NULL
);

CREATE TABLE "UserCache" (
  "url" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "args" TEXT,
  "body" TEXT NOT NULL,
  "timestamp" DOUBLE PRECISION NOT NULL,
  PRIMARY KEY ("url", "userId"),
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX "UserCache_userId_idx" ON "UserCache" ("userId");

CREATE TABLE "UserPreference" (
  "userId" TEXT PRIMARY KEY,
  "background" TEXT,
  "hideFilters" TEXT,
  "hideFreeItems" TEXT,
  "hideNewItemLabel" TEXT,
  "language" TEXT,
  "prefer2dStickerEditor" TEXT,
  "statsForNerds" TEXT,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE TABLE "ApiCredential" (
  "apiKey" TEXT PRIMARY KEY,
  "comment" TEXT,
  "scope" TEXT,
  "createdAt" DOUBLE PRECISION NOT NULL,
  "updatedAt" DOUBLE PRECISION NOT NULL
);

CREATE TABLE "ApiAuthToken" (
  "token" TEXT PRIMARY KEY,
  "apiKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" DOUBLE PRECISION NOT NULL,
  FOREIGN KEY ("apiKey") REFERENCES "ApiCredential"("apiKey") ON DELETE CASCADE,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX "ApiAuthToken_userId_idx" ON "ApiAuthToken" ("userId");
CREATE INDEX "ApiAuthToken_apiKey_idx" ON "ApiAuthToken" ("apiKey");

CREATE TABLE "Rule" (
  "name" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL DEFAULT 'string',
  "value" TEXT NOT NULL
);

CREATE TABLE "UserRule" (
  "name" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  PRIMARY KEY ("name", "userId"),
  FOREIGN KEY ("name") REFERENCES "Rule"("name") ON DELETE CASCADE,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE TABLE "Group" (
  "id" TEXT PRIMARY KEY,
  "priority" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "UserGroup" (
  "groupId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  PRIMARY KEY ("groupId", "userId"),
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE TABLE "GroupRule" (
  "groupId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  PRIMARY KEY ("groupId", "name"),
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE,
  FOREIGN KEY ("name") REFERENCES "Rule"("name") ON DELETE CASCADE
);

CREATE INDEX "UserRule_userId_idx" ON "UserRule" ("userId");
CREATE INDEX "UserGroup_userId_idx" ON "UserGroup" ("userId");
CREATE INDEX "GroupRule_groupId_idx" ON "GroupRule" ("groupId");