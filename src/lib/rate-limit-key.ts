/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — bucket key derivation for rate limiting
 *
 *  Bucket keys are stored in a real table, so anything derived from request
 *  metadata is attacker-controlled and can reintroduce exactly the
 *  unbounded-growth problem that `existsUser` gating fixed for the spray and
 *  stattrak limiters: N requests creating N rows. Keys therefore come from one
 *  of two places, and the first is always preferred:
 *
 *    1. A *credential* — api key, user id, the Electron shared secret. Cardinality
 *       is bounded by the number of credentials that exist, so it cannot grow
 *       with traffic. API keys are hashed with SHA-256 rather than used raw, so
 *       the table never becomes a place where a leaked backup hands out live
 *       credentials.
 *
 *    2. A *shard* of the client address, for endpoints reachable with no
 *       credential at all. Folding the address space into a fixed number of
 *       shards caps the table at `IP_RATE_LIMIT_SHARDS` rows per endpoint no
 *       matter how many distinct addresses appear, and a forged
 *       `X-Forwarded-For` can only pick a shard that already exists.
 *
 *  The second option's tradeoff is real rather than free: two unrelated clients
 *  in the same shard share a quota, so a determined attacker can dilute a
 *  legitimate user's budget. That is still the better failure mode — a single
 *  global bucket would let one attacker lock out every user at once.
 *--------------------------------------------------------------------------------------------*/

/**
 * Buckets an unauthenticated endpoint may create. 256 keeps its footprint at a
 * few hundred rows while spreading a normal visitor population thinly enough
 * that collisions stay rare.
 */
export const IP_RATE_LIMIT_SHARDS = 256;

/**
 * Best-effort client address. `CF-Connecting-IP` is written by Cloudflare and
 * replaces whatever the client sent, so it is preferred; `X-Forwarded-For` is
 * only consulted when Cloudflare is not in the path (`wrangler dev` locally, or
 * a direct hit on the origin).
 */
function clientAddress(request: Request): string {
  const cloudflare = request.headers.get("CF-Connecting-IP");
  if (cloudflare !== null && cloudflare !== "") {
    return cloudflare;
  }
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded !== null && forwarded !== "") {
    // The left-most entry is the original client.
    return forwarded.split(",")[0].trim();
  }
  // No address at all (Electron, some local tooling). Everything collapses into
  // one shard, which is the safe direction: it throttles rather than permits.
  return "unknown";
}

/** FNV-1a: non-cryptographic, inlined, and synchronous. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result >>> 0;
}

/**
 * Bucket key for an endpoint that needs no credential, derived from the client
 * address and folded into one of `IP_RATE_LIMIT_SHARDS` buckets.
 */
export function clientShardKey(request: Request, scope: string): string {
  const shard = hash(`${scope}:${clientAddress(request)}`) % IP_RATE_LIMIT_SHARDS;
  return `shard:${scope}:${shard}`;
}

/**
 * Bucket key derived from the `Authorization: Bearer` api key.
 *
 * Callers must have already run `isValidApiRequest`, so the header is present
 * and well-formed here. The key is hashed rather than stored: `RateLimitBucket`
 * rows outlive credential rotation and end up in backups, and there is no
 * reason for that table to hold live secrets. A truncated digest is enough to
 * separate keys and keeps the row short.
 */
export async function credentialKey(
  request: Request,
  scope: string
): Promise<string> {
  const apiKey = request.headers.get("Authorization")?.replace("Bearer ", "");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey ?? "")
  );
  const short = Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `key:${scope}:${short}`;
}
