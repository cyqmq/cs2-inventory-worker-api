/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — economy single-flight loader
 *
 *  Bundles the ~5 MB item table once, then keeps the CS2Economy singleton ready
 *  for every request. `language` is intentionally undefined: CS2EconomyItem
 *  names fall back to String(id), and English names come from the small
 *  item-names map (see getEnglishItemName / add-container).
 *--------------------------------------------------------------------------------------------*/

import { CS2Economy } from "@ianlucas/cs2-lib";
import items from "../data/items";
import { itemNames } from "../data/item-names";

let loaded = false;

export function ensureEconomyLoaded(): typeof CS2Economy {
  if (!loaded) {
    CS2Economy.load({ items });
    loaded = true;
  }
  return CS2Economy;
}

/** English item name by economy id (bundled separately from the item table). */
export function getEnglishItemName(id: number): string {
  return (itemNames as Record<string, string>)[String(id)] ?? String(id);
}