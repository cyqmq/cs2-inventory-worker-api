/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/admin/stats
 *
 *  Admin dashboard data: aggregate usage counters, per-route API call counts,
 *  per-day call volumes, and every user with a decoded summary of their
 *  inventory items. Gated behind `ADMIN_API_TOKEN` (bearer token); the endpoint
 *  returns 403 when the token is not configured and 401 on an invalid token.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { getRuntime } from "../env";
import { db } from "../db/database";
import { middleware } from "../middleware";
import { getEnglishItemName } from "../lib/economy-loader";
import {
  forbiddenResponse,
  methodNotAllowed,
  unauthorizedResponse
} from "../lib/responses";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Constant-time string comparison (length leak is acceptable for a bearer
 * token). `crypto.subtle.timingSafeEqual` is unavailable in workerd for
 * arbitrary byte lengths, so the XOR-accumulate variant is used instead.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/**
 * Gates /api/admin/stats behind a bearer token. The endpoint exposes every
 * user's Steam id, profile and inventory, so it must not be reachable by
 * anonymous callers on a public deployment. When `ADMIN_API_TOKEN` is unset the
 * dashboard is disabled outright.
 */
function assertAdminAuthorized(request: Request): void {
  const token = getRuntime().env.ADMIN_API_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    throw forbiddenResponse;
  }
  const authHeader = request.headers.get("Authorization");
  const provided =
    authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : (request.headers.get("X-Admin-Token") ?? "").trim();
  if (provided.length === 0 || !timingSafeEqual(provided, token)) {
    throw unauthorizedResponse;
  }
}

function summarizeInventory(rawInventory: string | null) {
  if (rawInventory === null || rawInventory.trim().length === 0) {
    return { itemCount: 0, equippedCount: 0, items: [] as unknown[] };
  }
  try {
    const data = JSON.parse(rawInventory) as {
      items?: Record<string, any>;
    };
    const entries = Object.entries(data.items ?? {});
    let equippedCount = 0;
    const items = entries.map(([uid, item]) => {
      const equipped =
        item.equipped === true ||
        item.equippedCT === true ||
        item.equippedT === true;
      if (equipped) {
        equippedCount += 1;
      }
      return {
        uid: Number(uid),
        id: item.id,
        name: getEnglishItemName(item.id),
        wear: item.wear ?? undefined,
        statTrak: item.statTrak,
        nameTag: item.nameTag,
        stickerCount: Object.keys(item.stickers ?? {}).length,
        keychainCount: Object.keys(item.keychains ?? {}).length,
        equipped
      };
    });
    return { itemCount: items.length, equippedCount, items };
  } catch {
    return { itemCount: 0, equippedCount: 0, items: [] as unknown[] };
  }
}

export async function adminStats(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  assertAdminAuthorized(request);

  const now = Date.now();
  const last24h = now - DAY_MS;
  const last7d = now - 7 * DAY_MS;

  const [{ count: totalUsers }] = await db()
    .selectFrom("User")
    .select(db().fn.countAll().as("count"))
    .execute();
  const [{ count: totalApiCalls }] = await db()
    .selectFrom("RequestLog")
    .select(db().fn.countAll().as("count"))
    .execute();
  const [{ count: apiCalls24h }] = await db()
    .selectFrom("RequestLog")
    .select(db().fn.countAll().as("count"))
    .where("createdAt", ">=", last24h)
    .execute();
  const [{ count: activeUsers24h }] = await db()
    .selectFrom("User")
    .select(db().fn.countAll().as("count"))
    .where("lastSeen", ">=", last24h)
    .execute();

  const apiCallsByRoute = await db()
    .selectFrom("RequestLog")
    .select([
      "method",
      "path",
      "status",
      db().fn.countAll().as("count")
    ])
    .groupBy(["method", "path", "status"])
    .orderBy("count", "desc")
    .limit(20)
    .execute();

  const apiCallsByDayRows = await db()
    .selectFrom("RequestLog")
    .select("createdAt")
    .where("createdAt", ">=", last7d)
    .execute();
  const dayMap = new Map<string, number>();
  for (const row of apiCallsByDayRows) {
    const day = new Date(row.createdAt).toISOString().slice(0, 10);
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
  }
  const apiCallsByDay = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day, count }));

  const userRows = await db()
    .selectFrom("User")
    .select([
      "id",
      "name",
      "avatar",
      "lastSeen",
      "createdAt",
      "inventoryVersion",
      "inventory"
    ])
    .orderBy("lastSeen", "desc")
    .limit(500)
    .execute();

  const users = userRows.map((user) => {
    const summary = summarizeInventory(user.inventory);
    return {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      lastSeen: user.lastSeen,
      createdAt: user.createdAt,
      inventoryVersion: user.inventoryVersion,
      itemCount: summary.itemCount,
      equippedCount: summary.equippedCount,
      items: summary.items
    };
  });

  return c.json({
    stats: {
      totalUsers,
      activeUsers24h,
      totalApiCalls,
      apiCalls24h,
      totalItems: users.reduce((sum, user) => sum + user.itemCount, 0),
      apiCallsByRoute,
      apiCallsByDay
    },
    users
  });
}