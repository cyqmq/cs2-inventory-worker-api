/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — API credentials (port of api/models/api-credential.server.ts)
 *--------------------------------------------------------------------------------------------*/

import { db } from "../db/database";

export const API_AUTH_SCOPE = "api_auth";
export const API_SCOPE = "api";
export const INVENTORY_SCOPE = "inventory";
export const SPRAY_CONSUME_SCOPE = "spray_consume";
export const STATTRAK_INCREMENT_SCOPE = "stattrak_increment";

export async function isApiKeyValid(apiKey: string, scope?: string[]) {
  const credentials = await db()
    .selectFrom("ApiCredential")
    .select("scope")
    .where("apiKey", "=", apiKey)
    .executeTakeFirst();
  if (credentials === undefined) {
    return false;
  }
  const credentialScope =
    credentials.scope?.split(",").map((scope) => scope.trim()) ?? [];
  return scope
    ? scope.some((scope) => credentialScope.includes(scope))
    : true;
}