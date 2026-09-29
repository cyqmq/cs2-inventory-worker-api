/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — user preferences (port of api/models/user-preference.server.ts)
 *--------------------------------------------------------------------------------------------*/

import { db } from "../db/database";

export type UserPreferenceKeys =
  | "background"
  | "hideFilters"
  | "hideFreeItems"
  | "hideNewItemLabel"
  | "language"
  | "prefer2dStickerEditor"
  | "statsForNerds";

export async function getUserPreference(
  userId: string,
  key: UserPreferenceKeys
) {
  return (
    (
      await db()
        .selectFrom("UserPreference")
        .select(key)
        .where("userId", "=", userId)
        .executeTakeFirst()
    )?.[key] ?? undefined
  );
}

export async function getUserPreferences<Keys extends UserPreferenceKeys>(
  userId: string,
  keys: Keys[]
) {
  return Object.fromEntries(
    await Promise.all(
      keys.map(
        async (key) => [key, await getUserPreference(userId, key)] as const
      )
    )
  ) as { [k in Keys]: Awaited<ReturnType<typeof getUserPreference>> };
}

export async function setUserPreference(
  userId: string,
  preference: UserPreferenceKeys,
  value: string | null
) {
  await db()
    .insertInto("UserPreference")
    .values({ [preference]: value, userId })
    .onConflict((oc) =>
      oc.column("userId").doUpdateSet({
        [preference]: value
      })
    )
    .execute();
}

export async function setUserPreferences(
  userId: string,
  preferences: { [key in UserPreferenceKeys]: string | null }
) {
  await db()
    .insertInto("UserPreference")
    .values({ ...preferences, userId })
    .onConflict((oc) =>
      oc.column("userId").doUpdateSet({
        ...preferences
      })
    )
    .execute();
}