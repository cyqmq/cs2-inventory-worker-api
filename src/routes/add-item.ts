/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — POST /api/add-item
 *  Port of api.add-item._index.tsx.
 *--------------------------------------------------------------------------------------------*/

import { z } from "zod";
import type { Context } from "hono";
import { middleware } from "../middleware";
import {
  API_SCOPE,
  INVENTORY_SCOPE,
  isApiKeyValid
} from "../models/api-credential";
import { findUniqueUser, manipulateUserInventory } from "../models/user";
import {
  badRequest,
  methodNotAllowed,
  noContent,
  unauthorizedResponse
} from "../lib/responses";
import { apiKeyShape, clientInventoryItemShape, userIdShape } from "../lib/shapes";

export async function addItem(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  const { apiKey, userId, inventoryItem } = z
    .object({
      apiKey: apiKeyShape,
      inventoryItem: clientInventoryItemShape,
      userId: userIdShape
    })
    .parse(await request.json());

  if (!(await isApiKeyValid(apiKey, [API_SCOPE, INVENTORY_SCOPE]))) {
    throw unauthorizedResponse;
  }

  try {
    const user = await findUniqueUser(userId);
    if (user === undefined) {
      return badRequest;
    }
    await manipulateUserInventory({
      rawInventory: user.inventory,
      userId,
      manipulate(inventory) {
        inventory.add(inventoryItem);
      }
    });
    return noContent;
  } catch {
    return badRequest;
  }
}