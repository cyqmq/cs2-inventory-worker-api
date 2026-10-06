/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/admin/stats
 *
 *  Admin dashboard data: aggregate usage counters, per-route API call counts,
 *  per-day call volumes, and every user with a decoded summary of their
 *  inventory items. No authentication is enforced yet — this is a development
 *  tool for self-hosted/preview deployments. Gate it behind an admin token
 *  before exposing the Worker publicly.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { db } from "../db/database";
import { middleware } from "../middleware";
import { getEnglishItemName } from "../lib/economy-loader";
import { methodNotAllowed } from "../lib/responses";

const DAY_MS = 24 * 60 * 60 * 1000;

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