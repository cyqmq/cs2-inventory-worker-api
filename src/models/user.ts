/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — user model (port of api/models/user.server.ts)
 *--------------------------------------------------------------------------------------------*/

import {
  CS2Inventory,
  CS2_INVENTORY_VERSION
} from "@ianlucas/cs2-lib";
import { db } from "../db/database";
import { parseInventory } from "../lib/inventory";
import { badRequest, conflict } from "../lib/responses";
import { inventoryMaxItems, inventoryStorageUnitMaxItems } from "./rule";

export async function getUserInventory(userId: string): Promise<string | null> {
  return (
    (
      await db()
        .selectFrom("User")
        .select("inventory")
        .where("id", "=", userId)
        .executeTakeFirst()
    )?.inventory ?? null
  );
}

export async function getUserInventoryVersion(userId: string) {
  return (
    (
      await db()
        .selectFrom("User")
        .select("inventoryVersion")
        .where("id", "=", userId)
        .executeTakeFirst()
    )?.inventoryVersion ?? null
  );
}

export async function upsertUser(user: {
  avatar: { medium: string };
  nickname: string;
  steamID: string;
  /**
   * Whether `nickname`/`avatar` came from Steam. When false they are fallbacks,
   * and an existing profile is left untouched instead of being overwritten with
   * "Player"/"" because a single Steam request failed. Defaults to true so
   * callers that already hold a real profile (e.g. the Electron flow) keep the
   * previous behaviour.
   */
  profileResolved?: boolean;
}): Promise<string> {
  const now = Date.now();
  const profileResolved = user.profileResolved ?? true;
  await db()
    .insertInto("User")
    .values({
      id: user.steamID,
      avatar: user.avatar.medium,
      name: user.nickname,
      inventory: null,
      inventoryVersion: 0,
      lastSeen: now,
      syncedAt: now,
      createdAt: now,
      updatedAt: now
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet(
        profileResolved
          ? {
              avatar: user.avatar.medium,
              name: user.nickname,
              updatedAt: now
            }
          : { updatedAt: now }
      )
    )
    .execute();
  return user.steamID;
}

export interface UserPublicData {
  avatar: string;
  createdAt: number;
  id: string;
  name: string;
  updatedAt: number;
  inventory: string | null;
  syncedAt: number;
}

export async function findUniqueUser(
  userId: string
): Promise<UserPublicData | undefined> {
  const user = await db()
    .selectFrom("User")
    .select(["avatar", "createdAt", "id", "name", "updatedAt"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (user === undefined) {
    return undefined;
  }
  return {
    ...user,
    inventory: await getUserInventory(userId),
    syncedAt: await getUserSyncedAt(userId)
  };
}

export async function existsUser(userId: string): Promise<boolean> {
  return (
    (await db()
      .selectFrom("User")
      .select("id")
      .where("id", "=", userId)
      .executeTakeFirst()) !== undefined
  );
}

export async function updateUserInventory(
  userId: string,
  inventory: string,
  inventoryVersion?: number
): Promise<{ syncedAt: number }> {
  const syncedAt = Date.now();
  return (
    await db()
      .updateTable("User")
      .set({
        inventory,
        inventoryVersion,
        syncedAt,
        updatedAt: syncedAt
      })
      .where("id", "=", userId)
      .returning("syncedAt")
      .executeTakeFirstOrThrow()
  );
}

export async function touchLastSeen(userId: string, throttleMs = 3_600_000) {
  await db()
    .updateTable("User")
    .set({ lastSeen: Date.now() })
    .where("id", "=", userId)
    .where("lastSeen", "<", Date.now() - throttleMs)
    .execute();
}

export async function getUserSyncedAt(userId: string): Promise<number> {
  return (
    await db()
      .selectFrom("User")
      .select("syncedAt")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow()
  ).syncedAt;
}

export async function getUserBasicData(userId: string) {
  return (
    (await db()
      .selectFrom("User")
      .select(["avatar", "name"])
      .where("id", "=", userId)
      .executeTakeFirst()) || undefined
  );
}

export async function manipulateUserInventory({
  manipulate,
  rawInventory,
  syncedAt,
  userId
}: {
  manipulate:
    | ((inventory: CS2Inventory) => void)
    | ((inventory: CS2Inventory) => Promise<void>);
  rawInventory: string | null;
  syncedAt?: number;
  userId: string;
}) {
  const inventory = new CS2Inventory({
    data: parseInventory(rawInventory),
    maxItems: await inventoryMaxItems.for(userId).get(),
    storageUnitMaxItems: await inventoryStorageUnitMaxItems.for(userId).get()
  });
  try {
    await manipulate(inventory);
  } catch {
    throw badRequest;
  }
  if (syncedAt !== undefined) {
    const currentSyncedAt = await getUserSyncedAt(userId);
    if (syncedAt !== currentSyncedAt) {
      throw conflict;
    }
  }
  // Persist the current data version so middleware doesn't re-run the
  // migration on the next request (a re-run rewrites the row and bumps
  // syncedAt behind the client's back → spurious 409s).
  return await updateUserInventory(
    userId,
    inventory.stringify(),
    CS2_INVENTORY_VERSION
  );
}