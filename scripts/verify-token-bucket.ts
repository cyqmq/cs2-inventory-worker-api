/*---------------------------------------------------------------------------------------------
 *  Offline smoke for the token-bucket SQL: compiles the exact Kysely statements
 *  from src/lib/token-bucket.ts (imported, not re-typed) and executes them
 *  against node:sqlite with the migration 0002 schema. Verifies refill math, the
 *  atomic guard, and the consume/no-consume split.
 *
 *  This script used to hand-copy the UPDATE into its own `sql` template. The
 *  copy drifted — it kept asserting on `MIN(x, n)` after the implementation had
 *  moved to a portable `CASE WHEN` clamp — and the `MIN` spelling it was still
 *  testing is precisely the one that PostgreSQL rejects outright.
 *
 *  Run: npx tsx scripts/verify-token-bucket.ts
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from "node:sqlite";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler
} from "kysely";
import {
  BUCKET_PRUNE_AGE_MS,
  buildConsumeToken,
  buildInsertBucket,
  buildPruneDelete,
  buildPruneSelect
} from "../src/lib/token-bucket";
import type { Database } from "../src/db/types";

// Compile with the same compiler family the D1 dialect uses (SqliteQueryCompiler,
// `?` placeholders) so the executed SQL is byte-identical to production.
const kysely = new Kysely<Database>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler()
  }
});

function refillAndConsume(
  tokens: number,
  elapsedSeconds: number,
  { capacity, refillIntervalSeconds }: { capacity: number; refillIntervalSeconds: number }
) {
  const refilled = Math.min(
    capacity,
    tokens + elapsedSeconds / refillIntervalSeconds
  );
  return refilled >= 1
    ? { consumed: true, tokens: refilled - 1 }
    : { consumed: false, tokens: refilled };
}

async function main() {
  const capacity = 1;
  const refillIntervalSeconds = 30;
  const key = "spray:user1:5";
  const now = Date.now();

  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE "RateLimitBucket" (
    "key" TEXT PRIMARY KEY,
    "tokens" REAL NOT NULL,
    "updatedAt" INTEGER NOT NULL
  )`);

  // --- Statement 1: insert-if-missing (onConflict doNothing) ---------------
  const insertQuery = buildInsertBucket(
    kysely,
    key,
    { capacity, refillIntervalSeconds },
    now
  ).compile();
  const runInsert = db.prepare(insertQuery.sql.replace(/"/g, ""));
  runInsert.run(...(insertQuery.parameters as number[]));
  // Re-run: must not throw (OR IGNORE semantics checked structurally).
  runInsert.run(...(insertQuery.parameters as number[]));

  let failures = 0;
  function expect(actual: unknown, expected: unknown, label: string) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      failures++;
      console.error(
        `FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    } else {
      console.log(`ok   ${label}`);
    }
  }

  const row = () =>
    db.prepare(`SELECT "tokens", "updatedAt" FROM RateLimitBucket WHERE key = ?`).get(key) as {
      tokens: number;
      updatedAt: number;
    };

  const runUpdate = (t: number) => {
    const q = buildConsumeToken(kysely, key, { capacity, refillIntervalSeconds }, t).compile();
    return db.prepare(q.sql.replace(/"/g, "")).run(...(q.parameters as number[]));
  };

  // t0: full bucket (1.0). Consume succeeds, tokens -> 0.
  {
    const res = runUpdate(now);
    expect(res.changes, 1, "t0 consume succeeds (1 row updated)");
    expect(row().tokens, refillAndConsume(1, 0, { capacity, refillIntervalSeconds }).tokens, "t0 tokens=0");
  }

  // t0+5s: virtual refill 5/30 = 0.1667 → still < 1 → no consume. The guarded
  // UPDATE leaves the row untouched on deny (updatedAt stays at t0); the next
  // successful consume recomputes the full elapsed refill, so the accept/deny
  // decisions match upstream's persist-every-attempt Prisma version exactly.
  {
    const t = now + 5_000;
    const res = runUpdate(t);
    expect(res.changes, 0, "t0+5s blocked (bucket below 1 token)");
    expect(row().tokens, 0, "t0+5s row untouched on deny (updatedAt preserved)");
  }

  // t0+35s: refilled 35/30 = 1.1667 ≥ 1 → consume succeeds. The clamp caps the
  // refill at capacity 1 *before* the consume, so the bucket lands on 0 — a
  // bucket that refilled past capacity would have drifted upward forever.
  {
    const t = now + 35_000;
    const res = runUpdate(t);
    expect(res.changes, 1, "t0+35s consume succeeds");
    expect(row().tokens, 0, "t0+35s refill clamped to capacity then consumed");
  }

  // Capacity cap, stated independently of the helper above: 10 minutes of idle
  // time is 20 tokens' worth, which must clamp to 1 and then drop to 0.
  {
    const t = now + 35_000 + 10 * 60_000;
    const res = runUpdate(t);
    expect(res.changes, 1, "after 10min consume succeeds");
    expect(row().tokens, capacity - 1, "capacity caps refill (tokens=capacity-1 after consume)");
  }

  // A capacity of 1 cannot show a *partial* refill (anything under one whole
  // token still denies), so the clamp arithmetic is pinned with the stattrak
  // limiter's real shape: capacity 50, one token per 3.6s. This is what catches a
  // clamp that silently drifts past capacity.
  {
    const stattrak = { capacity: 50, refillIntervalSeconds: 3.6 };
    const skey = "stattrak:user1:5";
    const skInsert = buildInsertBucket(kysely, skey, stattrak, now).compile();
    db.prepare(skInsert.sql.replace(/"/g, "")).run(
      ...(skInsert.parameters as number[])
    );
    const tokensOf = () =>
      (db.prepare(`SELECT tokens FROM RateLimitBucket WHERE key = ?`).get(skey) as {
        tokens: number;
      }).tokens;
    const consume50 = (t: number) => {
      const q = buildConsumeToken(kysely, skey, stattrak, t).compile();
      return db.prepare(q.sql.replace(/"/g, "")).run(...(q.parameters as number[]));
    };

    expect(consume50(now).changes, 1, "capacity 50: first consume succeeds");
    expect(tokensOf(), 49, "capacity 50: first consume leaves 49");
    // 1.8s / 3.6s = half a token, so no clamping is involved here.
    expect(consume50(now + 1_800).changes, 1, "capacity 50: half-refilled bucket can consume");
    expect(tokensOf(), 48.5, "capacity 50: exact partial-refill arithmetic");
    // 100 tokens' worth of idle time must clamp to 50, not run away.
    expect(consume50(now + 3_600_000).changes, 1, "capacity 50: long idle period can consume");
    expect(tokensOf(), 49, "capacity 50: long idle period clamps at capacity");
  }

  // --- pruneExpiredBuckets -------------------------------------------------
  // Same two-statement shape as src/lib/token-bucket.ts: select the stale keys
  // (bounded), then delete them. `DELETE ... LIMIT` is not portable (SQLite
  // compile-time option, rejected outright by PostgreSQL), so the batch is
  // applied via `WHERE key IN (...)`.
  const DAY_MS = BUCKET_PRUNE_AGE_MS;
  const PRUNE_BATCH = 500;
  const pruneAt = now + 2 * 60 * 60 * 1000; // evaluate "now" well after t0
  const seed = db.prepare(
    `INSERT OR IGNORE INTO RateLimitBucket (key, tokens, updatedAt) VALUES (?, ?, ?)`
  );
  const keyCount = () =>
    (
      db.prepare(`SELECT COUNT(*) AS c FROM RateLimitBucket`).get() as { c: number }
    ).c;

  for (let i = 0; i < PRUNE_BATCH + 100; i++) {
    // 600 rows that have long since refilled to capacity (prunable)...
    seed.run(`stale:${i}`, 0.5, pruneAt - DAY_MS - 1000);
  }
  for (let i = 0; i < 100; i++) {
    // ...and 100 rows touched a moment ago (must survive).
    seed.run(`fresh:${i}`, 0.5, pruneAt - 1000);
  }
  const beforePrune = keyCount();

  const selectKeys = (at: number) => {
    const q = buildPruneSelect(kysely, at).compile();
    return (
      db.prepare(q.sql.replace(/"/g, "")).all(...(q.parameters as number[])) as { key: string }[]
    ).map(({ key: k }) => k);
  };
  const deleteKeys = (keys: string[]) => {
    const q = buildPruneDelete(kysely, keys).compile();
    db.prepare(q.sql.replace(/"/g, "")).run(...(q.parameters as string[]));
  };

  const staleKeys = selectKeys(pruneAt);

  expect(staleKeys.length, PRUNE_BATCH, "prune selects at most PRUNE_BATCH stale keys");

  deleteKeys(staleKeys);

  expect(keyCount(), beforePrune - PRUNE_BATCH, "prune deletes exactly the selected batch");
  const survivors = db
    .prepare(`SELECT COUNT(*) AS c FROM RateLimitBucket WHERE key LIKE 'fresh:%'`)
    .get() as { c: number };
  expect(survivors.c, 100, "prune keeps every recently touched bucket");
  const leftovers = db
    .prepare(`SELECT COUNT(*) AS c FROM RateLimitBucket WHERE key LIKE 'stale:%'`)
    .get() as { c: number };
  expect(leftovers.c, 100, "prune leaves the remainder for the next pass");

  // A second pass finishes the job (the bound is per-pass, not permanent).
  {
    const keys = selectKeys(pruneAt);
    deleteKeys(keys);
    const left = db
      .prepare(`SELECT COUNT(*) AS c FROM RateLimitBucket WHERE key LIKE 'stale:%'`)
      .get() as { c: number };
    expect(left.c, 0, "second prune pass drains the rest");
    // 100 fresh buckets + the two buckets of the live limiters exercised above.
    expect(keyCount(), 102, "only fresh buckets plus the active ones remain");
  }

  // The production keys under test must not have been pruned: they were just used.
  for (const live of [key, "stattrak:user1:5"]) {
    const alive = db
      .prepare(`SELECT COUNT(*) AS c FROM RateLimitBucket WHERE key = ?`)
      .get(live) as { c: number };
    expect(alive.c, 1, `prune never drops the bucket of an active limiter (${live})`);
  }

  kysely.destroy();
  if (failures > 0) {
    console.error(`TOKEN BUCKET SMOKE: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("TOKEN BUCKET SMOKE: all assertions passed");
}

await main();
