/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/users
 *
 *  Port of api.users._index.tsx. Prisma's PostgreSQL full-text search against
 *  name/id is replaced with a portable LIKE filter that works identically on D1
 *  (SQLite) and PostgreSQL. The highest-priority group per user is computed with
 *  a single join instead of Prisma's nested `take: 1` include.
 *
 *  Two things the LIKE port has to handle itself, because the values are
 *  parameterized and therefore never interpreted as SQL but *are* interpreted
 *  as a LIKE pattern:
 *    - `page` must be a non-negative integer. `Number("abc")` is NaN and
 *      `Number("1e309")` is Infinity, which Kysely happily passes to OFFSET and
 *      the driver rejects (500); a negative value is silently clamped to 0 by
 *      SQLite but *rejected* by PostgreSQL, so the same request would behave
 *      differently on the two supported backends.
 *    - `%` and `_` are LIKE metacharacters. Unescaped, `search=%` matches every
 *      user and `search=_` matches any single character, turning the endpoint
 *      into a full-table scan on demand.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import type { ExpressionBuilder } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../db/database";
import type { Database } from "../db/types";
import { middleware, isValidApiRequest } from "../middleware";
import { API_SCOPE } from "../models/api-credential";
import { methodNotAllowed } from "../lib/responses";
import { credentialKey } from "../lib/rate-limit-key";
import {
  USER_SEARCH_RATE_LIMIT,
  enforceRateLimit
} from "../lib/token-bucket";

/** Escapes the LIKE metacharacters; the ESCAPE clause is spelled out below. */
function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function users(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  await isValidApiRequest(request, [API_SCOPE]);
  // Keyed on the api key, not the caller: the endpoint is credential-gated, so
  // the bucket cardinality is bounded by the number of keys rather than by
  // however many addresses are hitting it. Done before the query so a search
  // loop is throttled rather than served.
  await enforceRateLimit(
    await credentialKey(request, "users"),
    USER_SEARCH_RATE_LIMIT
  );
  const url = new URL(request.url);
  const page = z
    .string()
    .regex(/^\d{1,9}$/)
    .transform((value) => Number.parseInt(value, 10))
    .parse(url.searchParams.get("page") ?? "0");
  const search = z
    .string()
    .max(128)
    .parse(url.searchParams.get("search") ?? "");
  const take = 10;
  // Order matters: escape the user's own `%`/`_`/`\` first, *then* apply the
  // upstream whitespace normalization. Doing it the other way round would escape
  // the `_` this line deliberately introduces and silently turn "type a space,
  // match any single character" into "type a space, match a literal underscore".
  // @see https://github.com/prisma/prisma/issues/8939#issuecomment-933990947
  const like = `%${escapeLike(search).replace(/[\s\n\t]/g, "_")}%`;

  let countQuery = db()
    .selectFrom("User")
    .select(db().fn.countAll().as("count"));
  let resultsQuery = db()
    .selectFrom("User")
    .select(["avatar", "id", "name", "updatedAt"]);
  if (search.length > 0) {
    // ESCAPE is explicit because SQLite's LIKE has no default escape character
    // while PostgreSQL's defaults to a backslash, so relying on either backend's
    // default would silently change which characters are wildcards.
    const where = (eb: ExpressionBuilder<Database, "User">) =>
      eb.or([
        sql<boolean>`"name" LIKE ${like} ESCAPE '\\'`,
        sql<boolean>`"id" LIKE ${like} ESCAPE '\\'`
      ]);
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