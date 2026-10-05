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
 *
 *  Rows are never deleted by the caller, so a bucket key derived from
 *  user-controlled input (spray:{userId}:{uid}) would grow the table without
 *  bound. `pruneExpiredBuckets` drops rows that have had time to refill to a
 *  full bucket; it runs at most once per isolate per PRUNE_INTERVAL_MS.
 *--------------------------------------------------------------------------------------------*/

import { sql, type Expression, type Kysely } from "kysely";
import { db } from "../db/database";
import type { Database } from "../db/types";
import { tooManyRequests } from "./responses";

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

/**
 * Limits for the endpoints that are reachable without a session. They are keyed
 * by client shard rather than by address so the bucket table stays bounded — see
 * `clientShardKey`. Generous enough that a person clicking around a share link
 * never notices, tight enough that a script stops making progress.
 */
export const PUBLIC_READ_RATE_LIMIT: RateLimit = {
  capacity: 60,
  refillIntervalSeconds: 60
};

/** `/api/auth/electron` mints a session and can create a user, so it is tighter. */
export const ELECTRON_AUTH_RATE_LIMIT: RateLimit = {
  capacity: 10,
  refillIntervalSeconds: 60
};

/** Credential-keyed limits: cardinality is bounded by the credential count. */
export const SIGN_IN_RATE_LIMIT: RateLimit = {
  capacity: 30,
  refillIntervalSeconds: 60
};

export const USER_SEARCH_RATE_LIMIT: RateLimit = {
  capacity: 60,
  refillIntervalSeconds: 60
};

/**
 * Upstream's in-memory limiter allowed one inspect-link import per second per
 * user. Same budget, but enforced in the database.
 */
export const IMPORT_INSPECT_LINK_RATE_LIMIT: RateLimit = {
  capacity: 1,
  refillIntervalSeconds: 1
};

/**
 * A bucket whose `updatedAt` is older than this is indistinguishable from a
 * fresh one (it has long since refilled to `capacity`), so dropping it cannot
 * grant extra quota. Generous enough that no live limiter is affected.
 */
export const BUCKET_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

/** Cheap in-isolate throttle so pruning cannot itself become the hot path. */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const PRUNE_BATCH = 500;

let lastPruneAt = 0;
let pruneInFlight: Promise<void> | undefined;

export async function pruneExpiredBuckets(now = Date.now()): Promise<number> {
  // Portable batched delete: `DELETE ... LIMIT` is a SQLite compile-time option
  // and is not accepted by PostgreSQL at all, so select the keys first.
  const stale = await buildPruneSelect(db(), now).execute();
  if (stale.length === 0) {
    return 0;
  }
  await buildPruneDelete(db(), stale.map(({ key }) => key)).execute();
  return stale.length;
}

/**
 * Query builders, exported so that `scripts/verify-token-bucket.ts` and the
 * PGlite check exercise the statements that actually ship. They used to be
 * copy-pasted into those scripts, which is how `MIN(x, n)` survived review and
 * shipped broken on PostgreSQL.
 */
export function buildPruneSelect(database: Kysely<Database>, now: number) {
  return database
    .selectFrom("RateLimitBucket")
    .select("key")
    .where("updatedAt", "<", now - BUCKET_PRUNE_AGE_MS)
    .limit(PRUNE_BATCH);
}

export function buildPruneDelete(database: Kysely<Database>, keys: string[]) {
  return database.deleteFrom("RateLimitBucket").where("key", "in", keys);
}

/**
 * At most one prune per `PRUNE_INTERVAL_MS` per isolate, awaited rather than
 * detached. A promise left running past the response keeps the D1 write lock
 * held and stalls every later request in the same isolate, which shows up as
 * unexplained hangs on unrelated endpoints.
 */
async function maybePrune(now: number) {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) {
    return;
  }
  lastPruneAt = now;
  pruneInFlight ??= pruneExpiredBuckets(now)
    .then(() => {
      // Pruning is opportunistic; failures must not fail the request.
    })
    .catch(() => {})
    .finally(() => {
      pruneInFlight = undefined;
    });
  await pruneInFlight;
}

/**
 * Clamp `expression` to `capacity`, spelled so that it parses on both storage
 * backends.
 *
 * SQLite has a two-argument scalar `min(X, Y)`, but in PostgreSQL `min()` is
 * an *aggregate* that takes exactly one argument — `min(double precision,
 * integer)` does not exist, and neither does any implicit-cast path to it. The
 * obvious portable spelling therefore fails on Hyperdrive/Aiven with
 * `function min(double precision, integer) does not exist`, turning every
 * rate-limited request into a 500. `LEAST()` is the PostgreSQL answer but does
 * not exist in SQLite, and `GREATEST()` has the mirror problem.
 *
 * `CASE WHEN` is in the common subset of both, so it is the only form that
 * needs no dialect branch.
 */
function clampToCapacity(expression: Expression<unknown>, capacity: number) {
  return sql`CASE WHEN ${expression} > ${sql.lit(capacity)} THEN ${sql.lit(
    capacity
  )} ELSE ${expression} END`;
}

export async function consumeRateLimitToken(
  key: string,
  rateLimit: RateLimit
): Promise<boolean> {
  const now = Date.now();
  const database = db();

  await maybePrune(now);

  // Create the bucket full (skipDuplicates ≈ INSERT OR IGNORE on D1).
  await buildInsertBucket(database, key, rateLimit, now).execute();

  // Refill and consume in one guarded statement: read the stored state, top it
  // up to capacity with elapsed time, and only succeed when a full token is
  // available. tokens/updatedAt are read atomically together, so concurrent
  // invocations race on the WHERE clause and at most one consumes a token.
  const result = await buildConsumeToken(
    database,
    key,
    rateLimit,
    now
  ).executeTakeFirst();

  return result !== undefined;
}

/**
 * Consume a token and throw 429 when the bucket is empty.
 *
 * Every caller of `consumeRateLimitToken` wants exactly this, and forgetting to
 * act on `false` silently turns the limit into a no-op — which is how a limiter
 * ends up decorative. The one exception is the spray path, which has to spend
 * its token only after the api-key/public-rule branch is decided; it still calls
 * `consumeRateLimitToken` directly and throws `tooManyRequests` itself.
 */
export async function enforceRateLimit(
  key: string,
  rateLimit: RateLimit
): Promise<void> {
  if (!(await consumeRateLimitToken(key, rateLimit))) {
    throw tooManyRequests;
  }
}

/** Insert the bucket at full capacity, leaving an existing row alone. */
export function buildInsertBucket(
  database: Kysely<Database>,
  key: string,
  { capacity }: RateLimit,
  now: number
) {
  return database
    .insertInto("RateLimitBucket")
    .values({ key, tokens: capacity, updatedAt: now })
    .onConflict((oc) => oc.columns(["key"]).doNothing());
}

/** The guarded refill-and-consume UPDATE. See `clampToCapacity` for the clamp. */
export function buildConsumeToken(
  database: Kysely<Database>,
  key: string,
  { capacity, refillIntervalSeconds }: RateLimit,
  now: number
) {
  return database
    .updateTable("RateLimitBucket")
    .set((eb) => ({
      tokens: sql`${clampToCapacity(
        sql`${eb.ref("tokens")} + ((${sql.lit(now)} - ${eb.ref(
          "updatedAt"
        )}) / 1000.0) / ${sql.lit(refillIntervalSeconds)}`,
        capacity
      )} - 1`,
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
    .returning((eb) => [eb.ref("tokens").as("tokens")]);
}