/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — API auth tokens (port of api/models/api-auth-token.server.ts)
 *  `createdAt` is JS epoch ms; 60 second validity window.
 *--------------------------------------------------------------------------------------------*/

import { db } from "../db/database";

export async function generateAuthToken({
  apiKey,
  userId
}: {
  apiKey: string;
  userId: string;
}) {
  return (
    await db()
      .insertInto("ApiAuthToken")
      .values({
        apiKey,
        userId,
        createdAt: Date.now(),
        token: crypto.randomUUID()
      })
      .returning("token")
      .executeTakeFirstOrThrow()
  ).token;
}

export async function clearAuthTokens(userId: string) {
  await db().deleteFrom("ApiAuthToken").where("userId", "=", userId).execute();
}

export async function clearExpiredAuthTokens(userId: string) {
  await db()
    .deleteFrom("ApiAuthToken")
    .where("userId", "=", userId)
    .where("createdAt", "<=", Date.now() - 60000)
    .execute();
}

export async function getAuthTokenDetails(token: string) {
  const details = await db()
    .selectFrom("ApiAuthToken")
    .select(["userId", "createdAt"])
    .where("token", "=", token)
    .executeTakeFirst();
  return {
    details,
    valid:
      details?.createdAt !== undefined &&
      details.createdAt > Date.now() - 60000
  };
}