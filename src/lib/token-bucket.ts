/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — token-bucket rate limiting (port of
 *  api/models/rate-limit.server.ts)
 *
 *  Upstream keeps a bucket row per key and refills it continuously inside a
 *  serialized Prisma transaction (`SELECT ... FOR UPDATE`). Workers have no
 *  such row lock, so the compare-and-swap is expressed as a single UPDATE
 *  guarded by the stale token count; a false result means another invocation
 *  consumed the token first. D1 auto-commits per statement, so this is atomic
 *  on SQLite as well. On PostgreSQL the same statement runs inside its
 *  implicit transaction, so concurrent workers race on the WHERE clause only —
 *  at most one gets the token.
 *
 *  Buckets live in their own table (`RateLimitBucket`, migration 0002), so the
 *  schema stays compatible with the upstream Prisma model of the same name.
 *--------------------------------------------------------------------------------------------*/

import { sql } from "kysely";
import { db } from "../db/database";
import type { Database } from "../db/types";

export interface RateLimit {
  capacity: number;
  refillIntervalSeconds: number;
}

export const STATTRAK_INCREMENT_RATE_LIMIT: RateLimit = {
  capacity: 50,
  refillIntervalSeconds: 3.6
};

export const SPRAY_CONSUME_RATE_LIMIT: RateLimit = {
  capacity: 1,
  refillIntervalSeconds: 30
};

export async function consumeRateLimitToken(
  key: string,
  rateLimit: RateLimit
): Promise<boolean> {
  const { capacity, refillIntervalSeconds } = rateLimit;
  const now = Date.now();

  // Create the bucket full (skipDuplicates ≈ INSERT OR IGNORE on D1).
  await db()
    .insertInto("RateLimitBucket")
    .values({ key, tokens: capacity, updatedAt: now })
    .onConflict((oc) => oc.columns(["key"]).doNothing())
    .execute();

  // Refill and consume in one guarded statement: read the stored state, top it
  // up to capacity with elapsed time, and only succeed when a full token is
  // available. tokens/updatedAt are read atomically together, so concurrent
  // invocations race on the WHERE clause and at most one consumes a token.
  const result = await db()
    .updateTable("RateLimitBucket")
    .set((eb) => ({
      tokens: sql`MIN(${eb.ref("tokens")} + ((${sql.lit(now)} - ${eb.ref(
        "updatedAt"
      )}) / 1000.0) / ${sql.lit(refillIntervalSeconds)}, ${sql.lit(
        capacity
      )}) - 1`,
      updatedAt: sql.lit(now)
    }))
    .where("key", "=", key)
    .where((eb) =>
      eb(
        "tokens",
        ">=",
        sql<number>`1 - ((${sql.lit(now)} - "RateLimitBucket"."updatedAt") / 1000.0) / ${sql.lit(refillIntervalSeconds)}`
      )
    )
    .returning((eb) => [eb.ref("tokens").as("tokens")])
    .executeTakeFirst();

  return result !== undefined;
}
