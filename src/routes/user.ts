/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/user/:userId
 *  Port of api.user.$userId._index.tsx (findUnique + groups include).
 *  Returns `null` (not 404) when the user does not exist, like Prisma's
 *  findUnique.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { db } from "../db/database";
import { middleware } from "../middleware";
import { isValidApiRequest } from "../middleware";
import { API_SCOPE } from "../models/api-credential";
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