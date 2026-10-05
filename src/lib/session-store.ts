/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — server-side session store (migration 0003)
 *
 *  The session cookie is a self-contained HMAC-signed blob, so the server cannot
 *  invalidate one: a cookie taken from a log, a shared machine or a backup stays
 *  good for ~68 years (Max-Age=2147483647). Sign-out before this only told the
 *  browser to drop its copy — replaying the old cookie still returned 200.
 *
 *  A session is therefore also a row in `Session`, keyed by a random `sid` that
 *  is minted at sign-in and carried inside the signed payload. Because the
 *  payload is signed, a client cannot invent or swap a `sid`; it can only replay
 *  one it was legitimately given, and that one is checkable against the row.
 *
 *  Three states are enforced on every request:
 *    - unknown sid          -> rejected (signed out, or the row was swept)
 *    - revokedAt not null   -> rejected immediately, on the next request
 *    - expiresAt in the past-> rejected
 *
 *  Expiry is the interesting half, because a cookie can be replayed with its own
 *  Max-Age stripped or forged: the row's expiresAt is the bound that a client
 *  cannot influence.
 *--------------------------------------------------------------------------------------------*/

import { db } from "../db/database";

/** Sessions are valid for 30 days. Chosen to match a typical "remember me". */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How often expired-and-revoked rows are swept, per isolate. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 500;

let lastSweepAt = 0;
let sweepInFlight: Promise<void> | undefined;

/**
 * Batched delete, same two-statement shape as the bucket pruner: `DELETE ...
 * LIMIT` is a SQLite compile-time option and is rejected outright by PostgreSQL.
 */
export async function sweepSessions(now = Date.now()): Promise<number> {
  const stale = await db()
    .selectFrom("Session")
    .select("sid")
    .where((eb) =>
      eb.or([
        eb("expiresAt", "<", now),
        eb("revokedAt", "is not", null)
      ])
    )
    .limit(SWEEP_BATCH)
    .execute();
  if (stale.length === 0) {
    return 0;
  }
  await db()
    .deleteFrom("Session")
    .where(
      "sid",
      "in",
      stale.map(({ sid }) => sid)
    )
    .execute();
  return stale.length;
}

/**
 * Runs at most one sweep per `SWEEP_INTERVAL_MS` per isolate, and swallows
 * failures: housekeeping must never turn a sign-in into an error.
 */
async function maybeSweep(now: number) {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) {
    return;
  }
  lastSweepAt = now;
  sweepInFlight ??= sweepSessions(now)
    .then(() => {
      // Opportunistic housekeeping.
    })
    .catch(() => {})
    .finally(() => {
      sweepInFlight = undefined;
    });
  await sweepInFlight;
}

function randomSid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Record a live session for `userId` and return its id, to be embedded in the
 * cookie payload.
 *
 * Called on every sign-in. A re-login from the same browser inserts a new row
 * rather than updating the old one, so the previous cookie keeps working — that
 * is deliberate: signing in on a second device must not sign the first one out,
 * and signing *out* is the operation that revokes.
 */
export async function createSession(userId: string, now = Date.now()): Promise<string> {
  const sid = randomSid();
  await db()
    .insertInto("Session")
    .values({ sid, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS, revokedAt: null })
    .execute();
  // Awaited rather than left running detached: a promise that outlives the
  // response keeps the D1 write lock held, and every later request in the
  // isolate queues behind it. The gate below still limits this to at most one
  // sweep per hour per isolate, so the added latency is negligible.
  await maybeSweep(now);
  return sid;
}

/**
 * True when `sid` names a session that is still usable. Unknown, revoked and
 * expired ids all return false.
 */
export async function isSessionLive(sid: string, now = Date.now()): Promise<boolean> {
  const row = await db()
    .selectFrom("Session")
    .select(["expiresAt", "revokedAt"])
    .where("sid", "=", sid)
    .executeTakeFirst();
  if (row === undefined) {
    return false;
  }
  if (row.revokedAt !== null) {
    return false;
  }
  return row.expiresAt > now;
}

/**
 * Revoke one session (sign-out) or every session for a user ("sign out
 * everywhere"). Returns the number of rows stamped, so a caller can tell the
 * difference between revoking something that existed and not.
 *
 * Stamping rather than deleting matters: the point is that the *next* request
 * presenting that sid fails. The sweep reclaims the row afterwards.
 */
export async function revokeSession(
  userId: string,
  now = Date.now(),
  options: { sid?: string } = {}
): Promise<number> {
  let query = db()
    .updateTable("Session")
    .set({ revokedAt: now })
    .where("userId", "=", userId)
    .where("revokedAt", "is", null);
  if (options.sid !== undefined) {
    query = query.where("sid", "=", options.sid);
  }
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}
