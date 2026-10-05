/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/user/:userId, GET /api/user/basic/:userId
 *  Port of api.user.$userId._index.tsx (findUnique + groups include).
 *  Returns `null` (not 404) when the user does not exist, like Prisma's
 *  findUnique.
 *
 *  `/api/user/basic/:userId` has no upstream counterpart: it exists so a public
 *  craft share link can show the author's name and avatar. It is deliberately
 *  unauthenticated (matching /api/inventory/:userId.json, which already exposes
 *  the whole inventory) and returns only `{ avatar, name }`.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { db } from "../db/database";
import { middleware } from "../middleware";
import { isValidApiRequest } from "../middleware";
import { API_SCOPE } from "../models/api-credential";
import { getUserBasicData } from "../models/user";
import { methodNotAllowed } from "../lib/responses";
import { clientShardKey, credentialKey } from "../lib/rate-limit-key";
import { PUBLIC_READ_RATE_LIMIT, enforceRateLimit } from "../lib/token-bucket";

export async function user(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  await isValidApiRequest(request, [API_SCOPE]);
  // Credential-gated endpoint, so the bucket is keyed on the api key (hashed) and
  // cannot be grown by rotating source addresses.
  await enforceRateLimit(
    await credentialKey(request, "user"),
    PUBLIC_READ_RATE_LIMIT
  );
  const userId = c.req.param("userId");
  if (userId === undefined) {
    return c.json(null);
  }
  const row = await db()
    .selectFrom("User")
    .selectAll()
    .where("id", "=", userId)
    .executeTakeFirst();
  if (row === undefined) {
    return c.json(null);
  }
  const groups = await db()
    .selectFrom("UserGroup")
    .select(["groupId", "userId"])
    .where("userId", "=", userId)
    .execute();
  return c.json({
    ...row,
    groups
  });
}

export async function userBasic(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  // Deliberately unauthenticated (see the file header), which makes this the one
  // user-scoped read an anonymous caller can loop over. Shard-keyed so the bucket
  // table stays bounded no matter how many addresses are used to do it.
  await enforceRateLimit(
    clientShardKey(request, "user-basic"),
    PUBLIC_READ_RATE_LIMIT
  );
  const userId = c.req.param("userId");
  if (userId === undefined) {
    return c.json(null);
  }
  return c.json((await getUserBasicData(userId)) ?? null);
}