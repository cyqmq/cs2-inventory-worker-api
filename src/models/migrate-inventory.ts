/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — inventory migration
 *
 *  cs2-lib v9 replaced ad-hoc healing with a first-class pipeline:
 *  `decodeInventoryData` migrates stored JSON to the current format version and
 *  `CS2Inventory`'s constructor repairs invalid items and drops unknown ones.
 *  What remains here is the *policy* layer the library deliberately leaves to
 *  the deployment:
 *    - strip attachments the item type cannot hold (would brick the item),
 *    - clamp/drop wear outside the item's range,
 *    - drop sticker-slab keychains (display cases are not keychains),
 *    - drop free/default items left without any paid attachment.
 *  The healed inventory is written back at VERSION so the migration runs once.
 *--------------------------------------------------------------------------------------------*/

import {
  CS2Economy,
  clamp,
  decodeInventoryData,
  CS2_INVENTORY_VERSION
} from "@ianlucas/cs2-lib";
import {
  getUserInventory,
  getUserInventoryVersion,
  updateUserInventory
} from "./user";
import { baseStickerSlabId } from "../lib/economy";
import { hasKeys } from "../lib/misc";
import { ensureEconomyLoaded } from "../lib/economy-loader";
import type { CS2BaseInventoryItem, CS2InventoryData } from "@ianlucas/cs2-lib";

/**
 * The library's data version (v9 writes 2). Stored inventories below it are
 * decoded and migrated by decodeInventoryData before healing.
 */
const VERSION = CS2_INVENTORY_VERSION;
const pending = new Map<string, Promise<unknown>>();

function healItem(
  uid: string,
  inventoryItem: CS2BaseInventoryItem,
  inventory: CS2InventoryData
) {
  const item = CS2Economy.get(inventoryItem.id);

  // Strip attributes the item type cannot hold. These bricked the whole
  // inventory on load because CS2InventoryItem validates on construction
  // (e.g. a knife/glove carrying stickers, a non-agent carrying patches).
  if (inventoryItem.stickers !== undefined && !item.hasStickers()) {
    inventoryItem.stickers = undefined;
  }
  if (inventoryItem.keychains !== undefined && !item.hasKeychains()) {
    inventoryItem.keychains = undefined;
  }
  if (inventoryItem.patches !== undefined && !item.hasPatches()) {
    inventoryItem.patches = undefined;
  }

  // Clamp wear into the item's valid range, or drop it if the item cannot
  // hold wear at all (e.g. gloves stored below their wearMin).
  if (
    inventoryItem.wear !== undefined &&
    !CS2Economy.safeValidateWear(inventoryItem.wear, item)
  ) {
    inventoryItem.wear = item.hasWear()
      ? clamp(
          inventoryItem.wear,
          item.getMinimumWear(),
          item.getMaximumWear()
        )
      : undefined;
    // Re-check: drop anything still invalid (e.g. excess precision).
    if (
      inventoryItem.wear !== undefined &&
      !CS2Economy.safeValidateWear(inventoryItem.wear, item)
    ) {
      inventoryItem.wear = undefined;
    }
  }

  if (inventoryItem.keychains !== undefined) {
    for (const [slot] of Object.entries(inventoryItem.keychains).filter(
      ([, { id }]) => id === baseStickerSlabId
    )) {
      delete inventoryItem.keychains[slot];
    }
  }

  // Free items need to have some paid econ attached to them. Run this last so
  // an item left empty by the healing above is dropped.
  if (
    item.isDefault &&
    (inventoryItem.stickers === undefined ||
      !hasKeys(inventoryItem.stickers)) &&
    (inventoryItem.keychains === undefined ||
      !hasKeys(inventoryItem.keychains)) &&
    inventoryItem.nameTag === undefined
  ) {
    delete inventory.items[Number(uid)];
  }
}

async function applyMigration(userId: string, rawInventory: string) {
  ensureEconomyLoaded();
  let data: CS2InventoryData;
  try {
    // Decodes and migrates v1 → v2 (v9's CS2Inventory.load does this too, but
    // we need the plain data to heal before constructing an inventory).
    ({ data } = decodeInventoryData(rawInventory));
  } catch {
    // Unreadable inventory: leave it alone rather than wiping user data.
    return;
  }
  for (const [uid, inventoryItem] of Object.entries(data.items)) {
    healItem(uid, inventoryItem, data);
  }
  await updateUserInventory(userId, JSON.stringify(data), VERSION);
}

export async function migrateInventory(userId?: string) {
  if (userId === undefined) {
    return;
  }
  const version = await getUserInventoryVersion(userId);
  if (version === null || version >= VERSION) {
    return;
  }
  const rawInventory = await getUserInventory(userId);
  if (rawInventory === null) {
    return;
  }
  if (!pending.has(userId)) {
    pending.set(userId, applyMigration(userId, rawInventory));
  }
  await pending.get(userId);
  pending.delete(userId);
}
