/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — user cache (port of api/models/user-cache.server.ts)
 *  `timestamp` is JS epoch ms (getUserSyncedAt already returns a number).
 *--------------------------------------------------------------------------------------------*/

import type { CS2InventoryData } from "@ianlucas/cs2-lib";
import { z } from "zod";
import { db } from "../db/database";
import { res } from "../lib/responses";
import { parseInventory } from "../lib/inventory";
import { getUserInventory, getUserSyncedAt } from "./user";

export async function handleUserCachedResponse({
  args,
  generate,
  throwBody,
  url,
  userId
}: {
  args: string | null;
  generate:
    | ((inventory: CS2InventoryData, userId: string) => unknown)
    | ((inventory: CS2InventoryData, userId: string) => Promise<unknown>);
  throwBody: object | string;
  url: string;
  userId: string;
}) {
  const mimeType =
    typeof throwBody === "string" ? "text/html" : "application/json";
  const user = await db()
    .selectFrom("User")
    .select("id")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (user === undefined) {
    throw typeof throwBody === "string"
      ? res(throwBody, mimeType)
      : Response.json(throwBody);
  }
  const timestamp = await getUserSyncedAt(userId);
  const cache = await db()
    .selectFrom("UserCache")
    .select("body")
    .where("userId", "=", userId)
    .where("url", "=", url)
    .where("timestamp", "=", timestamp)
    .where("args", args === null ? "is" : "=", args)
    .executeTakeFirst();
  if (cache !== undefined) {
    return res(cache.body, mimeType);
  }
  const inventory = parseInventory(await getUserInventory(userId));
  if (!inventory) {
    throw typeof throwBody === "string"
      ? res(throwBody, mimeType)
      : Response.json(throwBody);
  }
  const generated = await generate(inventory, userId);
  const body =
    mimeType === "application/json"
      ? JSON.stringify(generated)
      : z.string().parse(generated);
  await db()
    .insertInto("UserCache")
    .values({
      args,
      body,
      timestamp,
      url,
      userId
    })
    .onConflict((oc) =>
      oc
        .columns(["url", "userId"])
        .doUpdateSet({
          args,
          body,
          timestamp
        })
    )
    .execute();
  return res(body, mimeType);
}