/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — /api/action routes
 *
 *  sync, resync, reset-inventory, unlock-case, import-inspect-link.
 *  Ports of the original routes; the 18-action sync protocol is reproduced
 *  verbatim (with scores of rule enforcements).
 *--------------------------------------------------------------------------------------------*/

import {
  CS2BaseInventoryItem,
  CS2Economy,
  CS2EconomyItem,
  CS2Inventory,
  CS2InventoryItem,
  CS2_INVENTORY_VERSION,
  CS2ItemType,
  CS2UnlockedItem,
  RecordValue,
  assert,
  repairInventoryItem,
  truncateToFactor
} from "@ianlucas/cs2-lib";
import {
  isSteamInspectLink,
  parseCSFloatItemInfo,
  parseInspectLink
} from "@ianlucas/cs2-lib-inspect";
import { z } from "zod";
import type { Context } from "hono";
import { getUserIdFromRequest, requireUser } from "../auth";
import { middleware } from "../middleware";
import {
  craftAllowImportInspectLink,
  craftAllowKeychains,
  craftAllowKeychainSeed,
  craftAllowKeychainX,
  craftAllowKeychainY,
  craftAllowKeychainZ,
  craftAllowNametag,
  craftAllowSeed,
  craftAllowStatTrak,
  craftAllowStickerRotation,
  craftAllowStickers,
  craftAllowStickerSchema,
  craftAllowStickerWear,
  craftAllowStickerX,
  craftAllowStickerY,
  craftAllowWear,
  craftHideCategory,
  craftHideId,
  craftHideModel,
  craftHideType,
  editAllowKeychains,
  editAllowKeychainSeed,
  editAllowKeychainX,
  editAllowKeychainY,
  editAllowKeychainZ,
  editAllowNametag,
  editAllowSeed,
  editAllowStatTrak,
  editAllowStickerRotation,
  editAllowStickers,
  editAllowStickerSchema,
  editAllowStickerWear,
  editAllowStickerX,
  editAllowStickerY,
  editAllowWear,
  editHideCategory,
  editHideId,
  editHideModel,
  editHideType,
  inventoryItemAllowApplyPatch,
  inventoryItemAllowApplySticker,
  inventoryItemAllowEdit,
  inventoryItemAllowRemovePatch,
  inventoryItemAllowRemoveSticker,
  inventoryItemAllowScrapeSticker,
  inventoryItemAllowUnlockContainer,
  inventoryItemMaxPatches,
  inventoryItemMaxStickers,
  inventoryMaxItems,
  inventoryStorageUnitMaxItems
} from "../models/rule";
import {
  manipulateUserInventory,
  updateUserInventory
} from "../models/user";
import {
  badRequest,
  conflict,
  forbiddenResponse,
  methodNotAllowed,
  tooManyRequests
} from "../lib/responses";
import { isAttachmentCountAllowed } from "../lib/attachments";
import { frontendRedirect } from "../lib/redirect";
import { editInventoryItem, parseInventory, type ItemEditorAttributes } from "../lib/inventory";
import { hasKeys } from "../lib/misc";
import {
  clientInventoryItemShape,
  itemEditorAttributesShape,
  nonNegativeInt,
  optionalKeychainOffset,
  optionalStickerOffset,
  optionalStickerRotation,
  optionalStickerWear,
  positiveInt,
  syncInventoryShape,
  teamShape
} from "../lib/shapes";
import { CS2_STICKER_OFFSET_FACTOR, isValidInspectLink, keychainOffsetFactor } from "../lib/economy";
import { fetchCSFloatItemInfo } from "../lib/csfloat";
import {
  IMPORT_INSPECT_LINK_RATE_LIMIT,
  enforceRateLimit
} from "../lib/token-bucket";

export const ApiActionSyncUrl = "/api/action/sync";
export const ApiActionResyncUrl = "/api/action/resync";
export const ApiActionResetInventoryUrl = "/api/action/reset-inventory";
export const ApiActionUnlockCaseUrl = "/api/action/unlock-case";
export const ApiActionImportInspectLinkUrl = "/api/action/import-inspect-link";

const SyncAction = {
  Add: "add",
  AddFromCache: "add-from-cache",
  AddWithKeychain: "add-with-keychain",
  AddWithNametag: "add-with-nametag",
  AddWithSticker: "add-with-sticker",
  ApplyItemKeychain: "apply-item-keychain",
  ApplyItemPatch: "apply-item-patch",
  ApplyItemSticker: "apply-item-sticker",
  DepositToStorageUnit: "deposit-to-storage-unit",
  Edit: "edit",
  Equip: "equip",
  ExtractItemSticker: "extract-item-sticker",
  Remove: "remove",
  RemoveAllItems: "remove-all-items",
  RemoveItemKeychain: "remove-item-keychain",
  RemoveItemPatch: "remove-item-patch",
  RemoveItemSticker: "remove-item-sticker",
  RenameItem: "rename-item",
  RenameStorageUnit: "rename-storage-unit",
  RetrieveFromStorageUnit: "retrieve-from-storage-unit",
  ScrapeItemSticker: "scrape-item-sticker",
  SealItemSticker: "seal-item-sticker",
  SwapItemsStatTrak: "swap-items-stattrak",
  UnpackItem: "unpack-item",
  UnsealItem: "unseal-item",
  Unequip: "unequip"
} as const;

const keychainPlacementShape = {
  x: optionalKeychainOffset,
  y: optionalKeychainOffset,
  z: optionalKeychainOffset
};

const stickerPlacementShape = {
  schema: nonNegativeInt,
  x: optionalStickerOffset,
  y: optionalStickerOffset,
  rotation: optionalStickerRotation,
  wear: optionalStickerWear
};

const actionShape = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(SyncAction.Add),
    item: clientInventoryItemShape
  }),
  z.object({
    type: z.literal(SyncAction.AddFromCache),
    data: syncInventoryShape
  }),
  z.object({
    type: z.literal(SyncAction.AddWithNametag),
    toolUid: nonNegativeInt,
    itemId: nonNegativeInt,
    nameTag: z.string()
  }),
  z.object({
    type: z.literal(SyncAction.ApplyItemKeychain),
    keychainUid: nonNegativeInt,
    targetUid: nonNegativeInt,
    ...keychainPlacementShape
  }),
  z.object({
    type: z.literal(SyncAction.ApplyItemPatch),
    patchUid: nonNegativeInt,
    slot: nonNegativeInt,
    targetUid: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.ApplyItemSticker),
    stickerUid: nonNegativeInt,
    targetUid: nonNegativeInt,
    ...stickerPlacementShape
  }),
  z.object({
    type: z.literal(SyncAction.ExtractItemSticker),
    uid: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.Equip),
    uid: nonNegativeInt,
    team: teamShape.optional()
  }),
  z.object({
    type: z.literal(SyncAction.Unequip),
    uid: nonNegativeInt,
    team: teamShape.optional()
  }),
  z.object({
    type: z.literal(SyncAction.RenameItem),
    toolUid: nonNegativeInt,
    targetUid: nonNegativeInt,
    nameTag: z.string().optional()
  }),
  z.object({
    type: z.literal(SyncAction.Remove),
    uid: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.RemoveItemKeychain),
    targetUid: nonNegativeInt,
    slot: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.RemoveItemPatch),
    targetUid: nonNegativeInt,
    slot: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.RemoveItemSticker),
    targetUid: nonNegativeInt,
    index: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.UnsealItem),
    uid: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.ScrapeItemSticker),
    targetUid: nonNegativeInt,
    index: nonNegativeInt,
    wear: optionalStickerWear
  }),
  z.object({
    type: z.literal(SyncAction.SealItemSticker),
    toolUid: nonNegativeInt,
    stickerUid: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.SwapItemsStatTrak),
    fromUid: nonNegativeInt,
    toUid: nonNegativeInt,
    toolUid: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.RenameStorageUnit),
    uid: nonNegativeInt,
    nameTag: z.string()
  }),
  z.object({
    depositUids: z.array(nonNegativeInt).max(1),
    type: z.literal(SyncAction.DepositToStorageUnit),
    uid: nonNegativeInt
  }),
  z.object({
    retrieveUids: z.array(nonNegativeInt).max(1),
    type: z.literal(SyncAction.RetrieveFromStorageUnit),
    uid: nonNegativeInt
  }),
  z.object({
    type: z.literal(SyncAction.Edit),
    uid: nonNegativeInt,
    attributes: itemEditorAttributesShape
  }),
  z.object({
    type: z.literal(SyncAction.AddWithKeychain),
    itemId: nonNegativeInt,
    keychainUid: nonNegativeInt,
    ...keychainPlacementShape
  }),
  z.object({
    type: z.literal(SyncAction.AddWithSticker),
    itemId: nonNegativeInt,
    stickerUid: nonNegativeInt,
    ...stickerPlacementShape
  }),
  z.object({
    type: z.literal(SyncAction.RemoveAllItems)
  }),
  z.object({
    type: z.literal(SyncAction.UnpackItem),
    uid: nonNegativeInt
  })
]);

type ActionShape = z.infer<typeof actionShape>;

type ApiActionSyncData = {
  syncedAt: number;
};

/**
 * Rejects an item / set of attributes carrying more attachments than the
 * inventoryItemMaxPatches / inventoryItemMaxStickers rules allow. `target` is
 * the item being edited, so lowering a limit never destroys what is already
 * there (see isAttachmentCountAllowed).
 */
async function enforceMaxAttachments(
  {
    patches,
    stickers
  }: Pick<Partial<CS2BaseInventoryItem>, "patches" | "stickers">,
  userId: string,
  target?: CS2InventoryItem
) {
  assert(
    isAttachmentCountAllowed({
      current: target?.getPatchesCount() ?? 0,
      max: await inventoryItemMaxPatches.for(userId).get(),
      next: patches !== undefined ? Object.keys(patches).length : 0
    })
  );
  assert(
    isAttachmentCountAllowed({
      current: target?.getStickersCount() ?? 0,
      max: await inventoryItemMaxStickers.for(userId).get(),
      next: stickers !== undefined ? Object.keys(stickers).length : 0
    })
  );
}

async function enforceCraftRulesForItem(
  idOrItem: number | CS2EconomyItem,
  userId: string
) {
  const { type, modelKey, id, loadoutCategory } = CS2Economy.get(idOrItem);
  await craftHideId.for(userId).notContains(id);
  if (loadoutCategory !== undefined) {
    await craftHideCategory.for(userId).notContains(loadoutCategory);
  }
  if (type !== undefined) {
    await craftHideType.for(userId).notContains(type);
  }
  if (modelKey !== undefined) {
    await craftHideModel.for(userId).notContains(modelKey);
  }
}

async function enforceCraftRulesForStickerAttributes(
  {
    wear,
    rotation,
    x,
    y,
    schema
  }: RecordValue<NonNullable<CS2BaseInventoryItem["stickers"]>>,
  userId: string
) {
  if (wear !== undefined) {
    await craftAllowStickerWear.for(userId).truthy();
  }
  if (rotation !== undefined) {
    await craftAllowStickerRotation.for(userId).truthy();
  }
  if (x !== undefined) {
    await craftAllowStickerX.for(userId).truthy();
  }
  if (y !== undefined) {
    await craftAllowStickerY.for(userId).truthy();
  }
  if (schema !== undefined) {
    await craftAllowStickerSchema.for(userId).truthy();
  }
}

async function enforceCraftRulesForKeychainAttributes(
  {
    seed,
    x,
    y,
    z
  }: RecordValue<NonNullable<CS2BaseInventoryItem["keychains"]>>,
  userId: string
) {
  if (seed !== undefined) {
    await craftAllowKeychainSeed.for(userId).truthy();
  }
  if (x !== undefined) {
    await craftAllowKeychainX.for(userId).truthy();
  }
  if (y !== undefined) {
    await craftAllowKeychainY.for(userId).truthy();
  }
  if (z !== undefined) {
    await craftAllowKeychainZ.for(userId).truthy();
  }
}

async function enforceCraftRulesForInventoryItem(
  item: Partial<CS2BaseInventoryItem>,
  userId: string
) {
  const { keychains, stickers, statTrak, wear, seed, nameTag } = item;
  await enforceMaxAttachments(item, userId);
  if (keychains !== undefined && hasKeys(keychains)) {
    await craftAllowKeychains.for(userId).truthy();
    await craftHideType.for(userId).notContains(CS2ItemType.Keychain);
    for (const keychain of Object.values(keychains)) {
      await enforceCraftRulesForItem(keychain.id, userId);
      await enforceCraftRulesForKeychainAttributes(keychain, userId);
    }
  }
  if (stickers !== undefined && hasKeys(stickers)) {
    await craftAllowStickers.for(userId).truthy();
    await craftHideType.for(userId).notContains(CS2ItemType.Sticker);
    for (const sticker of Object.values(stickers)) {
      await enforceCraftRulesForItem(sticker.id, userId);
      await enforceCraftRulesForStickerAttributes(sticker, userId);
    }
  }
  if (statTrak !== undefined) {
    await craftAllowStatTrak.for(userId).truthy();
  }
  if (wear !== undefined) {
    await craftAllowWear.for(userId).truthy();
  }
  if (seed !== undefined) {
    await craftAllowSeed.for(userId).truthy();
  }
  if (nameTag !== undefined) {
    await craftAllowNametag.for(userId).truthy();
  }
}

async function enforceEditRulesForItem(
  idOrItem: number | CS2EconomyItem,
  userId: string
) {
  const { type, modelKey, id, loadoutCategory } = CS2Economy.get(idOrItem);
  await editHideId.for(userId).notContains(id);
  if (loadoutCategory !== undefined) {
    await editHideCategory.for(userId).notContains(loadoutCategory);
  }
  if (type !== undefined) {
    await editHideType.for(userId).notContains(type);
  }
  if (modelKey !== undefined) {
    await editHideModel.for(userId).notContains(modelKey);
  }
}

async function enforceEditRulesForKeychainAttributes(
  {
    seed,
    x,
    y,
    z
  }: RecordValue<NonNullable<CS2BaseInventoryItem["keychains"]>>,
  userId: string
) {
  if (seed !== undefined) {
    await editAllowKeychainSeed.for(userId).truthy();
  }
  if (x !== undefined) {
    await editAllowKeychainX.for(userId).truthy();
  }
  if (y !== undefined) {
    await editAllowKeychainY.for(userId).truthy();
  }
  if (z !== undefined) {
    await editAllowKeychainZ.for(userId).truthy();
  }
}

async function enforceEditRulesForInventoryItem(
  attributes: Partial<ItemEditorAttributes>,
  userId: string,
  target: CS2InventoryItem
) {
  const { keychains, stickers, statTrak, wear, seed, nameTag } = attributes;
  await enforceMaxAttachments(attributes, userId, target);
  if (keychains !== undefined && hasKeys(keychains)) {
    await editAllowKeychains.for(userId).truthy();
    await editHideType.for(userId).notContains(CS2ItemType.Keychain);
    for (const keychain of Object.values(keychains)) {
      await enforceEditRulesForItem(keychain.id, userId);
      await enforceEditRulesForKeychainAttributes(keychain, userId);
    }
  }
  if (stickers !== undefined && hasKeys(stickers)) {
    await editAllowStickers.for(userId).truthy();
    await editHideType.for(userId).notContains(CS2ItemType.Sticker);
    for (const sticker of Object.values(stickers)) {
      await enforceEditRulesForItem(sticker.id, userId);
      await enforceEditRulesForStickerAttributes(sticker, userId);
    }
  }
  if (statTrak !== undefined) {
    await editAllowStatTrak.for(userId).truthy();
  }
  if (wear !== undefined) {
    await editAllowWear.for(userId).truthy();
  }
  if (seed !== undefined) {
    await editAllowSeed.for(userId).truthy();
  }
  if (nameTag !== undefined) {
    await editAllowNametag.for(userId).truthy();
  }
}

async function enforceEditRulesForStickerAttributes(
  {
    wear,
    rotation,
    x,
    y,
    schema
  }: RecordValue<NonNullable<CS2BaseInventoryItem["stickers"]>>,
  userId: string
) {
  if (wear !== undefined) {
    await editAllowStickerWear.for(userId).truthy();
  }
  if (rotation !== undefined) {
    await editAllowStickerRotation.for(userId).truthy();
  }
  if (x !== undefined) {
    await editAllowStickerX.for(userId).truthy();
  }
  if (y !== undefined) {
    await editAllowStickerY.for(userId).truthy();
  }
  if (schema !== undefined) {
    await editAllowStickerSchema.for(userId).truthy();
  }
}

export async function sync(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  const { id: userId, inventory: rawInventory } = await requireUser(request);
  const { syncedAt, actions } = z
    .object({
      syncedAt: z.number(),
      actions: z.array(actionShape)
    })
    .parse(await request.json());
  let addedFromCache = false;
  const { syncedAt: responseSyncedAt } = await manipulateUserInventory({
    rawInventory,
    syncedAt,
    userId,
    async manipulate(inventory) {
      for (const action of actions) {
        switch (action.type) {
          case SyncAction.Add:
            await enforceCraftRulesForItem(action.item.id, userId);
            await enforceCraftRulesForInventoryItem(action.item, userId);
            inventory.add(action.item);
            break;
          case SyncAction.AddFromCache:
            if (rawInventory === null && !addedFromCache) {
              for (const item of Object.values(action.data.items)) {
                try {
                  await enforceCraftRulesForItem(item.id, userId);
                  await enforceCraftRulesForInventoryItem(item, userId);
                  inventory.add(item);
                } catch {}
              }
              addedFromCache = true;
            }
            break;
          case SyncAction.AddWithNametag:
            await enforceCraftRulesForItem(action.itemId, userId);
            inventory.addWithNameTag(
              action.toolUid,
              action.itemId,
              action.nameTag
            );
            break;
          case SyncAction.ApplyItemPatch: {
            await inventoryItemAllowApplyPatch.for(userId).truthy();
            const count = inventory.get(action.targetUid).getPatchesCount();
            assert(
              isAttachmentCountAllowed({
                current: count,
                max: await inventoryItemMaxPatches.for(userId).get(),
                next: count + 1
              })
            );
            inventory.applyItemPatch(
              action.targetUid,
              action.patchUid,
              action.slot
            );
            break;
          }
          case SyncAction.ApplyItemSticker: {
            await inventoryItemAllowApplySticker.for(userId).truthy();
            const count = inventory.get(action.targetUid).getStickersCount();
            assert(
              isAttachmentCountAllowed({
                current: count,
                max: await inventoryItemMaxStickers.for(userId).get(),
                next: count + 1
              })
            );
            inventory.applyItemSticker(action.targetUid, action.stickerUid, {
              schema: action.schema,
              x: action.x,
              y: action.y,
              rotation: action.rotation,
              wear: action.wear
            });
            break;
          }
          case SyncAction.ApplyItemKeychain:
            inventory.applyItemKeychain(action.targetUid, action.keychainUid, {
              x: action.x,
              y: action.y,
              z: action.z
            });
            break;
          case SyncAction.Equip:
            inventory.equip(action.uid, action.team);
            break;
          case SyncAction.ExtractItemSticker:
            inventory.unsealStickerSlab(action.uid);
            break;
          case SyncAction.Unequip:
            inventory.unequip(action.uid, action.team);
            break;
          case SyncAction.UnsealItem:
            inventory.unsealItem(action.uid);
            break;
          case SyncAction.RenameItem:
            inventory.renameItem(
              action.toolUid,
              action.targetUid,
              action.nameTag
            );
            break;
          case SyncAction.Remove:
            inventory.remove(action.uid);
            break;
          case SyncAction.RemoveItemKeychain:
            inventory.removeItemKeychain(action.targetUid, action.slot);
            break;
          case SyncAction.RemoveItemPatch:
            await inventoryItemAllowRemovePatch.for(userId).truthy();
            inventory.removeItemPatch(action.targetUid, action.slot);
            break;
          case SyncAction.RemoveItemSticker:
            await inventoryItemAllowRemoveSticker.for(userId).truthy();
            inventory.removeItemSticker(action.targetUid, action.index);
            break;
          case SyncAction.ScrapeItemSticker:
            await inventoryItemAllowScrapeSticker.for(userId).truthy();
            inventory.scrapeItemSticker(
              action.targetUid,
              action.index,
              action.wear
            );
            break;
          case SyncAction.SealItemSticker:
            inventory.sealStickerSlab(action.toolUid, action.stickerUid);
            break;
          case SyncAction.SwapItemsStatTrak:
            inventory.swapItemsStatTrak(
              action.toolUid,
              action.fromUid,
              action.toUid
            );
            break;
          case SyncAction.RenameStorageUnit:
            inventory.renameStorageUnit(action.uid, action.nameTag);
            break;
          case SyncAction.DepositToStorageUnit:
            inventory.depositToStorageUnit(action.uid, action.depositUids);
            break;
          case SyncAction.RetrieveFromStorageUnit:
            inventory.retrieveFromStorageUnit(action.uid, action.retrieveUids);
            break;
          case SyncAction.Edit:
            await inventoryItemAllowEdit.for(userId).truthy();
            await enforceEditRulesForInventoryItem(
              action.attributes,
              userId,
              inventory.get(action.uid)
            );
            editInventoryItem(inventory, action.uid, action.attributes);
            break;
          case SyncAction.AddWithSticker:
            await enforceCraftRulesForItem(action.itemId, userId);
            assert(
              isAttachmentCountAllowed({
                current: 0,
                max: await inventoryItemMaxStickers.for(userId).get(),
                next: 1
              })
            );
            inventory.addWithSticker(action.stickerUid, action.itemId, {
              schema: action.schema,
              x: action.x,
              y: action.y,
              rotation: action.rotation,
              wear: action.wear
            });
            break;
          case SyncAction.RemoveAllItems:
            inventory.removeAll();
            break;
          case SyncAction.AddWithKeychain:
            await enforceCraftRulesForItem(action.itemId, userId);
            inventory.addWithKeychain(action.keychainUid, action.itemId, {
              x: action.x,
              y: action.y,
              z: action.z
            });
            break;
          case SyncAction.UnpackItem:
            inventory.unpackItem(action.uid);
            break;
        }
      }
    }
  });

  return c.json({
    syncedAt: responseSyncedAt
  } satisfies ApiActionSyncData);
}

export async function resync(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  const { syncedAt, inventory } = await requireUser(request);
  return c.json({
    syncedAt,
    inventory
  } satisfies ApiActionResyncData);
}

type ApiActionResyncData = {
  syncedAt: number;
  inventory: string | null;
};

/**
 * Same-origin guard for cookie-authenticated mutations that a cross-site page
 * could otherwise trigger. The session cookie is `SameSite=Lax`, which blocks
 * cross-site fetches and form posts but *not* a top-level GET navigation — so a
 * state-changing GET (the historical reset-inventory) is reachable from any
 * page via `<a href>` / `window.open` / `location =`.
 *
 * Browsers always send `Sec-Fetch-Site` on navigations and subrequests;
 * `cross-site` is the only value that means "this came from another origin".
 * Requests without the header are non-browser clients (curl, Electron's
 * net.fetch) and are allowed through so the API stays scriptable.
 */
export function assertSameOrigin(request: Request): void {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    throw forbiddenResponse;
  }
  const origin = request.headers.get("Origin");
  if (origin === null || origin === "null") {
    return;
  }
  if (origin !== new URL(request.url).origin) {
    throw forbiddenResponse;
  }
}

export async function resetInventory(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  // Both verbs are accepted. Upstream's `GET /reset-inventory` is a plain link
  // target, and the frontend's error boundary POSTs, so rejecting GET would be
  // a gratuitous behavioural break for a GET that `assertSameOrigin` already
  // gates.
  //
  // That gate is weaker for GET than it looks, and the residual exposure is
  // accepted rather than papered over: a *top-level navigation* GET carries
  // `Sec-Fetch-Site: cross-site`, which is rejected, but a browser that omits
  // `Sec-Fetch-Site` (any pre-~2022 Chromium, all Gecko before 90) also omits
  // `Origin` on a navigation, and both headers being absent passes. On such a
  // client an `<img>`/`<a>` from a third-party page can still wipe the
  // inventory. Callers that care should POST.
  if (request.method !== "POST" && request.method !== "GET") {
    throw methodNotAllowed;
  }
  assertSameOrigin(request);
  const { id: userId } = await requireUser(request);
  await updateUserInventory(
    userId,
    new CS2Inventory().stringify(),
    CS2_INVENTORY_VERSION
  );
  return frontendRedirect("/", 302);
}

type ApiActionUnlockCaseActionData = {
  syncedAt: number;
  unlockedItem: CS2UnlockedItem;
};

export async function unlockCase(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  const {
    id: userId,
    inventory: rawInventory,
    syncedAt: currentSyncedAt
  } = await requireUser(request);
  await inventoryItemAllowUnlockContainer.for(userId).truthy();
  const { caseUid, keyUid, syncedAt } = z
    .object({
      syncedAt: positiveInt,
      caseUid: nonNegativeInt,
      keyUid: nonNegativeInt.optional()
    })
    .parse(await request.json());
  if (syncedAt !== currentSyncedAt) {
    throw conflict;
  }
  const inventory = new CS2Inventory({
    data: parseInventory(rawInventory),
    maxItems: await inventoryMaxItems.for(userId).get(),
    storageUnitMaxItems: await inventoryStorageUnitMaxItems.for(userId).get()
  });
  const unlockedItem = inventory.get(caseUid).unlockContainer();
  inventory.unlockContainer(unlockedItem, caseUid, keyUid);
  const { syncedAt: responseSyncedAt } = await updateUserInventory(
    userId,
    inventory.stringify(),
    CS2_INVENTORY_VERSION
  );

  return c.json({
    unlockedItem,
    syncedAt: responseSyncedAt
  } satisfies ApiActionUnlockCaseActionData);
}

function postParseInventoryItem(item: CS2BaseInventoryItem) {
  if (item.keychains !== undefined) {
    for (const keychain of Object.values(item.keychains)) {
      if (keychain.x !== undefined) {
        keychain.x = truncateToFactor(keychain.x, keychainOffsetFactor);
      }
      if (keychain.y !== undefined) {
        keychain.y = truncateToFactor(keychain.y, keychainOffsetFactor);
      }
      if (keychain.z !== undefined) {
        keychain.z = truncateToFactor(keychain.z, keychainOffsetFactor);
      }
    }
  }
  if (item.stickers !== undefined) {
    for (const sticker of Object.values(item.stickers)) {
      if (sticker.x !== undefined) {
        sticker.x = truncateToFactor(sticker.x, CS2_STICKER_OFFSET_FACTOR);
      }
      if (sticker.y !== undefined) {
        sticker.y = truncateToFactor(sticker.y, CS2_STICKER_OFFSET_FACTOR);
      }
    }
  }
  return item;
}

export async function importInspectLink(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    throw badRequest;
  }
  if (!(await craftAllowImportInspectLink.for(userId).get())) {
    throw badRequest;
  }
  // Persistent bucket rather than the old in-memory cooldown map: a Workers
  // isolate can be evicted at any moment, so the 1s cooldown silently stopped
  // applying under load, and it never applied at all to the Hyperdrive backend
  // where isolates recycle much faster. Keyed on userId, so bucket cardinality is
  // bounded by the user count.
  await enforceRateLimit(
    `import-inspect-link:${userId}`,
    IMPORT_INSPECT_LINK_RATE_LIMIT
  );
  const { inspectLink } = z
    .object({
      inspectLink: z.string().refine((value) => isValidInspectLink(value))
    })
    .parse(await request.json());
  let item: CS2BaseInventoryItem;
  if (isSteamInspectLink(inspectLink)) {
    item = parseCSFloatItemInfo(
      CS2Economy,
      await fetchCSFloatItemInfo(inspectLink)
    );
  } else {
    try {
      item = parseInspectLink(CS2Economy, inspectLink);
    } catch {
      throw badRequest;
    }
  }
  // v9: repair clamps invalid attributes (or reports the item unrepairable),
  // matching upstream's import-inspect-link behavior.
  if (!repairInventoryItem(CS2Economy, item)) {
    throw badRequest;
  }
  // The item is not in the inventory yet, so there is no existing count to
  // preserve: anything above the configured limit is rejected outright.
  try {
    await enforceMaxAttachments(item, userId);
  } catch {
    throw forbiddenResponse;
  }
  return c.json(postParseInventoryItem(item));
}