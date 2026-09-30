/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — inventory helpers (server-safe subset of
 *  shared/utils/inventory.ts; no window / lz-string dependencies).
 *--------------------------------------------------------------------------------------------*/

import {
  CS2Inventory,
  CS2ItemType,
  decodeInventoryData,
  type CS2InventoryItem
} from "@ianlucas/cs2-lib";
import { serverInventoryShape } from "./shapes";

export const UNLOCKABLE_ITEM_TYPE: CS2ItemType[] = [
  CS2ItemType.Container,
  CS2ItemType.Key
];

export const EDITABLE_ITEM_TYPE: CS2ItemType[] = [
  CS2ItemType.Agent,
  CS2ItemType.Gloves,
  CS2ItemType.Keychain,
  CS2ItemType.Melee,
  CS2ItemType.MusicKit,
  CS2ItemType.Weapon
];

export const INSPECTABLE_ITEM_TYPE: CS2ItemType[] = [
  CS2ItemType.Collectible,
  CS2ItemType.Gloves,
  CS2ItemType.Graffiti,
  CS2ItemType.Keychain,
  CS2ItemType.Melee,
  CS2ItemType.MusicKit,
  CS2ItemType.Patch,
  CS2ItemType.Sticker,
  CS2ItemType.Weapon
];

export interface ItemEditorAttributes {
  keychains?: Record<
    string,
    { id: number; seed?: number; x?: number; y?: number; z?: number }
  >;
  nameTag?: string;
  patches?: Record<string, number>;
  quantity: number;
  seed?: number;
  statTrak?: boolean;
  stickers?: Record<
    string,
    { id: number; rotation?: number; schema?: number; wear?: number; x?: number; y?: number }
  >;
  wear?: number;
}

/**
 * Loads raw inventory JSON into a spec object for `new CS2Inventory(...)`.
 * v9 replaced the v8 `CS2Inventory.parse` with `CS2Inventory.load`, which both
 * decodes and migrates (v1 → v2) and repairs/drops invalid items; passing the
 * decoded data through the constructor keeps those semantics while letting the
 * callers shape options themselves.
 */
export function parseInventory(inventory?: string | null) {
  if (inventory === undefined || inventory === null) {
    return undefined;
  }
  try {
    const { data } = decodeInventoryData(inventory);
    return serverInventoryShape.parse(data);
  } catch {
    return undefined;
  }
}

export function editInventoryItem(
  inventory: CS2Inventory,
  uid: number,
  { statTrak, ...attributes }: Omit<ItemEditorAttributes, "quantity">
) {
  return inventory.edit(uid, {
    statTrak: statTrak ? (inventory.get(uid).statTrak ?? 0) : undefined,
    nameTag: attributes.nameTag,
    stickers: attributes.stickers,
    patches: attributes.patches,
    keychains: attributes.keychains,
    seed: attributes.seed,
    wear: attributes.wear
  });
}

export type { CS2InventoryItem };