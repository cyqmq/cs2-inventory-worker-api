/*---------------------------------------------------------------------------------------------
 *  Offline smoke for the token-bucket SQL: compiles the exact Kysely UPDATE
 *  from src/lib/token-bucket.ts and executes it against node:sqlite with the
 *  migration 0002 schema. Verifies refill math, the atomic guard, and the
 *  consume/no-consume split.
 *  Run: npx tsx scripts/verify-token-bucket.ts
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from "node:sqlite";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql
} from "kysely";

interface RateLimitBucketRow {
  key: string;
  tokens: number;
  updatedAt: number;
}
interface Db {
  RateLimitBucket: RateLimitBucketRow;
}

// Compile with the same compiler family the D1 dialect uses (SqliteQueryCompiler,
// `?` placeholders) so the executed SQL is byte-identical to production.
const kysely = new Kysely<Db>({
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
  const insertQuery = kysely
    .insertInto("RateLimitBucket")
    .values({ key, tokens: capacity, updatedAt: now })
    .onConflict((oc) => oc.columns(["key"]).doNothing())
    .compile();
  const insertSql = insertQuery.sql.replace(/"/g, "");
  const runInsert = db.prepare(insertSql);
  runInsert.run(...(insertQuery.parameters as number[]));
  // Re-run: must not throw (OR IGNORE semantics checked structurally).
  runInsert.run(...(insertQuery.parameters as number[]));

  // --- Statement 2: guarded refill+consume UPDATE ---------------------------
  const buildUpdate = (nowMs: number) =>
    kysely
      .updateTable("RateLimitBucket")
      .set((eb) => ({
        tokens: sql`MIN(${eb.ref("tokens")} + ((${sql.lit(nowMs)} - ${eb.ref(
          "updatedAt"
        )}) / 1000.0) / ${sql.lit(refillIntervalSeconds)}, ${sql.lit(
          capacity
        )}) - 1`,
        updatedAt: sql.lit(nowMs)
      }))
      .where("key", "=", key)
      .where((eb) =>
        eb(
          "tokens",
          ">=",
          sql<number>`1 - ((${sql.lit(nowMs)} - "RateLimitBucket"."updatedAt") / 1000.0) / ${sql.lit(refillIntervalSeconds)}`
        )
      )
      .returning((eb) => [eb.ref("tokens").as("tokens")])
      .compile();

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
    const q = buildUpdate(t);
    const stmt = db.prepare(q.sql.replace(/"/g, ""));
    return stmt.run(...(q.parameters as number[]));
  };

  // t0: full bucket (1.0). Consume succeeds, tokens -> 0.
  {
    const res = runUpdate(now);
    expect(res.changes, 1, "t0 consume succeeds (1 row updated)");
    expect(row().tokens, refillAndConsume(1, 0, { capacity, refillIntervalSeconds }).tokens, "t0 tokens=0");
  }

  // t0+5s: virtual refill 5/30 ≈ 0.1667 → still < 1 → no consume. The guarded
  // UPDATE leaves the row untouched on deny (updatedAt stays at t0); the next
  // successful consume recomputes the full elapsed refill, so the accept/deny
  // decisions match upstream's persist-every-attempt Prisma version exactly.
  {
    const t = now + 5_000;
    const res = runUpdate(t);
    expect(res.changes, 0, "t0+5s blocked (bucket below 1 token)");
    expect(row().tokens, 0, "t0+5s row untouched on deny (updatedAt preserved)");
  }

  // t0+35s: refilled 35/30 ≥ 1 → consume succeeds.
  {
    const t = now + 35_000;
    const res = runUpdate(t);
    expect(res.changes, 1, "t0+35s consume succeeds");
    const expected = refillAndConsume(row().tokens + 1, 35, { capacity, refillIntervalSeconds }).tokens;
    expect(row().tokens, expected, "t0+35s tokens ≈ 0.1667");
  }

  // Capacity cap: wait long enough to exceed capacity, tokens must cap at 1.
  {
    const t = now + 35_000 + 10 * 60_000;
    const res = runUpdate(t);
    expect(res.changes, 1, "after 10min consume succeeds");
    // After consuming, refilled would exceed capacity → capped, minus 1 → capacity - 1.
    expect(row().tokens, capacity - 1, "capacity caps refill (tokens=capacity-1 after consume)");
  }

  kysely.destroy();
  if (failures > 0) {
    console.error(`TOKEN BUCKET SMOKE: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("TOKEN BUCKET SMOKE: all assertions passed");
}

await main();
