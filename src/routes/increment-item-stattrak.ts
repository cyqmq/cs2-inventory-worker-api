/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — POST /api/increment-item-stattrak
 *  Port of api.increment-item-stattrak._index.tsx.
 *--------------------------------------------------------------------------------------------*/

import { assert } from "@ianlucas/cs2-lib";
import { z } from "zod";
import type { Context } from "hono";
import { middleware } from "../middleware";
import {
  API_SCOPE,
  STATTRAK_INCREMENT_SCOPE,
  isApiKeyValid
} from "../models/api-credential";
import {
  STATTRAK_INCREMENT_RATE_LIMIT,
  consumeRateLimitToken
} from "../lib/token-bucket";
import { apiPublicStatTrakIncrement } from "../models/rule";
import {
  existsUser,
  findUniqueUser,
  manipulateUserInventory
} from "../models/user";
import {
  badRequest,
  methodNotAllowed,
  noContent,
  tooManyRequests,
  unauthorizedResponse
} from "../lib/responses";
import { apiKeyShape, nonNegativeInt, userIdShape } from "../lib/shapes";

export async function incrementItemStatTrak(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  const { apiKey, userId, targetUid } = z
    .object({
      apiKey: apiKeyShape.optional(),
      userId: userIdShape,
      targetUid: nonNegativeInt
    })
    .parse(await request.json());

  // Existence first: consuming a token writes a RateLimitBucket row keyed by
  // the caller-supplied userId, so doing it before this check let anonymous
  // callers fill the table with buckets for users that do not exist.
  if (!(await existsUser(userId))) {
    throw badRequest;
  }

  if (apiKey !== undefined) {
    if (!(await isApiKeyValid(apiKey, [API_SCOPE, STATTRAK_INCREMENT_SCOPE]))) {
      throw unauthorizedResponse;
    }
  } else {
    if (!(await apiPublicStatTrakIncrement.for(userId).get())) {
      throw unauthorizedResponse;
    }
    if (
      !(await consumeRateLimitToken(
        `stattrak:${userId}:${targetUid}`,
        STATTRAK_INCREMENT_RATE_LIMIT
      ))
    ) {
      throw tooManyRequests;
    }
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
        const item = inventory.get(targetUid);
        assert(
          item.equipped === true ||
            item.equippedCT === true ||
            item.equippedT === true
        );
        inventory.incrementItemStatTrak(targetUid);
      }
    });
    return noContent;
  } catch {
    return badRequest;
  }
}
