/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — POST /api/add-container
 *  Port of api.add-container._index.tsx.
 *
 *  The original served per-language translations from `serverGlobals`; this
 *  worker bundles English names only, so the `language` parameter returns the
 *  English container name (the frontend re-localizes by id).
 *--------------------------------------------------------------------------------------------*/

import { CS2Economy, ensure } from "@ianlucas/cs2-lib";
import { z } from "zod";
import type { Context } from "hono";
import { middleware } from "../middleware";
import {
  API_SCOPE,
  INVENTORY_SCOPE,
  isApiKeyValid
} from "../models/api-credential";
import { findUniqueUser, manipulateUserInventory } from "../models/user";
import { getEnglishItemName } from "../lib/economy-loader";
import { badRequest, methodNotAllowed, unauthorizedResponse } from "../lib/responses";
import { random } from "../lib/misc";

export async function addContainer(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  const {
    apiKey,
    graffiti,
    language,
    name,
    souvenir,
    stickerCapsule,
    userId,
    weapon
  } = z
    .object({
      apiKey: z.string(),
      graffiti: z.boolean().optional(),
      language: z.string().optional(),
      name: z.string().optional(),
      souvenir: z.boolean().optional(),
      stickerCapsule: z.boolean().optional(),
      userId: z.string(),
      weapon: z.boolean().optional()
    })
    .parse(await request.json());

  if (!(await isApiKeyValid(apiKey, [API_SCOPE, INVENTORY_SCOPE]))) {
    throw unauthorizedResponse;
  }

  try {
    const item = ensure(
      random(
        CS2Economy.itemsAsArray.filter(
          (item) =>
            item.isContainer() &&
            (name === undefined ||
              getEnglishItemName(item.id)
                .toLowerCase()
                .includes(name.toLowerCase())) &&
            (souvenir !== true || item.isSouvenirCase()) &&
            (stickerCapsule !== true || item.isStickerCapsule()) &&
            (weapon !== true || item.isWeaponCase()) &&
            (graffiti !== true || item.isGraffitiBox())
        )
      )
    );
    const user = await findUniqueUser(userId);
    if (user === undefined) {
      return badRequest;
    }
    await manipulateUserInventory({
      rawInventory: user.inventory,
      userId,
      manipulate(inventory) {
        inventory.add({
          id: item.id
        });
      }
    });
    return c.json({
      ...item.item,
      ...(language !== undefined
        ? { name: getEnglishItemName(item.id) }
        : item.language)
    });
  } catch {
    return badRequest;
  }
}