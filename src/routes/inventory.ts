/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/inventory/:userId.json,
 *  GET /api/equipped/v4/:userId.json, GET /api/equipped/v5/:userId.json
 *
 *  Port of api.inventory.$userId[.]json, api.equipped.v4/v5.$userId[.]json.
 *  Hono v4 does not capture `:userId.json` params, so the routes are registered
 *  as wildcards and the userId is read from c.req.path (the `.json` suffix and
 *  the trailing slash are stripped).
 *--------------------------------------------------------------------------------------------*/

import { CS2Inventory, type CS2InventoryData } from "@ianlucas/cs2-lib";
import type { Context } from "hono";
import { middleware } from "../middleware";
import {
  getRules,
  inventoryItemEquipHideModel,
  inventoryItemEquipHideType,
  inventoryMaxItems,
  inventoryStorageUnitMaxItems
} from "../models/rule";
import { handleUserCachedResponse } from "../models/user-cache";
import { generate as generateV4 } from "../lib/equipped-v4";
import { generate as generateV5 } from "../lib/equipped-v5";
import { methodNotAllowed } from "../lib/responses";

export const ApiInventoryUserIdUrl = "/api/inventory/$userId.json";
export const ApiEquippedV4UserIdJsonUrl = "/api/equipped/v4/$userId.json";
export const ApiEquippedV5UserIdJsonUrl = "/api/equipped/v5/$userId.json";

/** Extract the userId tail from the request path. */
function userIdFromPath(c: Context, prefix: string): string {
  const path = c.req.path;
  let tail = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  tail = tail.replace(/^\/+/, "");
  if (tail.endsWith("/")) {
    tail = tail.slice(0, -1);
  }
  if (tail.endsWith(".json")) {
    tail = tail.slice(0, -".json".length);
  }
  return tail;
}

export async function inventory(c: Context) {
  const request = c.req.raw;
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  const userId = userIdFromPath(c, "/api/inventory");
  await middleware(request, userId);
  return await handleUserCachedResponse({
    args: null,
    generate(data: CS2InventoryData) {
      return data;
    },
    throwBody: {},
    url: ApiInventoryUserIdUrl,
    userId
  });
}

const equippedRules = {
  inventoryItemEquipHideModel,
  inventoryItemEquipHideType,
  inventoryMaxItems,
  inventoryStorageUnitMaxItems
};

export async function equippedV4(c: Context) {
  const request = c.req.raw;
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  const userId = userIdFromPath(c, "/api/equipped/v4");
  await middleware(request, userId);
  const rules = await getRules(equippedRules, userId);
  const args = [
    rules.inventoryItemEquipHideModel,
    rules.inventoryItemEquipHideType
  ].join(";");
  return await handleUserCachedResponse({
    args,
    generate(data: CS2InventoryData) {
      return generateV4(
        new CS2Inventory({
          data,
          maxItems: rules.inventoryMaxItems,
          storageUnitMaxItems: rules.inventoryStorageUnitMaxItems
        }),
        {
          models: rules.inventoryItemEquipHideModel,
          types: rules.inventoryItemEquipHideType
        }
      );
    },
    throwBody: {},
    url: ApiEquippedV4UserIdJsonUrl,
    userId
  });
}

export async function equippedV5(c: Context) {
  const request = c.req.raw;
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  const userId = userIdFromPath(c, "/api/equipped/v5");
  await middleware(request, userId);
  const rules = await getRules(equippedRules, userId);
  const args = [
    rules.inventoryItemEquipHideModel,
    rules.inventoryItemEquipHideType
  ].join(";");
  return await handleUserCachedResponse({
    args,
    generate(data: CS2InventoryData) {
      return generateV5(
        new CS2Inventory({
          data,
          maxItems: rules.inventoryMaxItems,
          storageUnitMaxItems: rules.inventoryStorageUnitMaxItems
        }),
        {
          models: rules.inventoryItemEquipHideModel,
          types: rules.inventoryItemEquipHideType
        }
      );
    },
    throwBody: {},
    url: ApiEquippedV5UserIdJsonUrl,
    userId
  });
}