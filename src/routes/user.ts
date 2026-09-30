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

export async function user(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  await isValidApiRequest(request, [API_SCOPE]);
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
  const userId = c.req.param("userId");
  if (userId === undefined) {
    return c.json(null);
  }
  return c.json((await getUserBasicData(userId)) ?? null);
}