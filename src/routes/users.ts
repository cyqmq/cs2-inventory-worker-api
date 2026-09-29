/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/users
 *
 *  Port of api.users._index.tsx. Prisma's PostgreSQL full-text search against
 *  name/id is replaced with a portable LIKE filter that works identically on D1
 *  (SQLite) and PostgreSQL. The highest-priority group per user is computed with
 *  a single join instead of Prisma's nested `take: 1` include.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import type { ExpressionBuilder } from "kysely";
import { z } from "zod";
import { db } from "../db/database";
import type { Database } from "../db/types";
import { middleware, isValidApiRequest } from "../middleware";
import { API_SCOPE } from "../models/api-credential";
import { methodNotAllowed } from "../lib/responses";

export async function users(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  await isValidApiRequest(request, [API_SCOPE]);
  const url = new URL(request.url);
  const page = z
    .string()
    .transform((value) => Number(value))
    .parse(url.searchParams.get("page") ?? "0");
  const search = z
    .string()
    .parse(url.searchParams.get("search") ?? "")
    // @see https://github.com/prisma/prisma/issues/8939#issuecomment-933990947
    .replace(/[\s\n\t]/g, "_");
  const take = 10;
  const like = `%${search}%`;

  let countQuery = db()
    .selectFrom("User")
    .select(db().fn.countAll().as("count"));
  let resultsQuery = db()
    .selectFrom("User")
    .select(["avatar", "id", "name", "updatedAt"]);
  if (search.length > 0) {
    const where = (eb: ExpressionBuilder<Database, "User">) =>
      eb.or([eb("name", "like", like), eb("id", "like", like)]);
    countQuery = countQuery.where(where);
    resultsQuery = resultsQuery.where(where);
  }
  const { count: rawCount } = await countQuery.executeTakeFirstOrThrow();
  const count = Number(rawCount);
  const rows = await resultsQuery
    .orderBy("syncedAt", "desc")
    .offset(page * take)
    .limit(take)
    .execute();

  const groupByUser = new Map<string, string | null>(
    rows.map((row) => [row.id, null])
  );
  if (rows.length > 0) {
    const groupRows = await db()
      .selectFrom("UserGroup")
      .innerJoin("Group", "Group.id", "UserGroup.groupId")
      .select(["UserGroup.groupId", "UserGroup.userId"])
      .where("UserGroup.userId", "in", rows.map((row) => row.id))
      .orderBy("Group.priority", "desc")
      .execute();
    for (const group of groupRows) {
      if (groupByUser.get(group.userId) === null) {
        groupByUser.set(group.userId, group.groupId);
      }
    }
  }

  const results = rows.map((row) => {
    const groupId = groupByUser.get(row.id);
    return {
      avatar: row.avatar,
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt,
      groups: groupId === null ? [] : [{ groupId }]
    };
  });

  return c.json({
    results,
    controls: {
      count,
      size: Math.ceil(count / take)
    }
  });
}