/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — POST /api/increment-item-stattrak
 *  Port of api.increment-item-stattrak._index.tsx.
 *--------------------------------------------------------------------------------------------*/

import { z } from "zod";
import type { Context } from "hono";
import { middleware } from "../middleware";
import {
  API_SCOPE,
  STATTRAK_INCREMENT_SCOPE,
  isApiKeyValid
} from "../models/api-credential";
import {
  existsUser,
  findUniqueUser,
  manipulateUserInventory
} from "../models/user";
import {
  badRequest,
  methodNotAllowed,
  noContent,
  unauthorizedResponse
} from "../lib/responses";
import { nonNegativeInt } from "../lib/shapes";

export async function incrementItemStatTrak(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  const { apiKey, userId, targetUid } = z
    .object({
      apiKey: z.string(),
      userId: z.string(),
      targetUid: nonNegativeInt
    })
    .parse(await request.json());

  if (!(await isApiKeyValid(apiKey, [API_SCOPE, STATTRAK_INCREMENT_SCOPE]))) {
    throw unauthorizedResponse;
  }

  if (!(await existsUser(userId))) {
    throw badRequest;
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
        inventory.incrementItemStatTrak(targetUid);
      }
    });
    return noContent;
  } catch {
    return badRequest;
  }
}