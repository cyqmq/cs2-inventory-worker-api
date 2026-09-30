/*---------------------------------------------------------------------------------------------
 *  Standalone verification for the cs2-lib v9 migration pipeline (no DB needed).
 *  Run: npx tsx scripts/verify-v9-migration.ts
 *--------------------------------------------------------------------------------------------*/

import {
  CS2Economy,
  CS2_INVENTORY_VERSION,
  decodeInventoryData
} from "@ianlucas/cs2-lib";
import { ensureEconomyLoaded } from "../src/lib/economy-loader";
import { baseStickerSlabId } from "../src/lib/economy";
import { hasKeys } from "../src/lib/misc";

let failures = 0;
function expect(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

function heal(data: ReturnType<typeof decodeInventoryData>["data"]) {
  for (const [uid, inventoryItem] of Object.entries(data.items)) {
    const item = CS2Economy.get(inventoryItem.id);
    if (inventoryItem.stickers !== undefined && !item.hasStickers()) {
      inventoryItem.stickers = undefined;
    }
    if (inventoryItem.keychains !== undefined && !item.hasKeychains()) {
      inventoryItem.keychains = undefined;
    }
    if (inventoryItem.patches !== undefined && !item.hasPatches()) {
      inventoryItem.patches = undefined;
    }
    if (inventoryItem.keychains !== undefined) {
      for (const [slot] of Object.entries(inventoryItem.keychains).filter(
        ([, { id }]) => id === baseStickerSlabId
      )) {
        delete inventoryItem.keychains[slot];
      }
    }
    if (
      item.isDefault &&
      (inventoryItem.stickers === undefined || !hasKeys(inventoryItem.stickers)) &&
      (inventoryItem.keychains === undefined || !hasKeys(inventoryItem.keychains)) &&
      inventoryItem.nameTag === undefined
    ) {
      delete data.items[Number(uid)];
    }
  }
  return data;
}

ensureEconomyLoaded();

// 1. v1 format (what the worker's DB stores today) migrates to v2.
const v1 = JSON.stringify({
  items: {
    "1": { id: 7 }, // AK-47, not default → survives
    "2": { id: 1 } // default knife slot? (id 1 = default item in economy)
  },
  version: 1
});
const { data, migratedFrom } = decodeInventoryData(v1);
expect(migratedFrom, 1, "v1 payload reports migratedFrom=1");
expect(data.version, CS2_INVENTORY_VERSION, "decoded version = library version");
expect(CS2_INVENTORY_VERSION, 2, "library version is 2");

// 2. Non-stickerable item carrying stickers (invalid combo) gets them
//    stripped. Note: id 7 (AK-47) is stickerable, so it must NOT be used
//    here; ids 37-46 have hasStickers() === false in the v9 economy data.
const bricked = decodeInventoryData(
  JSON.stringify({
    items: { "5": { id: 37, stickers: { "0": { id: 120 } } } },
    version: 2
  })
).data;
if (CS2Economy.get(37).hasStickers()) {
  throw new Error("economy changed: id 37 is now stickerable, pick another id");
}
const healedBricked = JSON.parse(JSON.stringify(bricked));
heal(healedBricked);
expect(
  healedBricked.items[5].stickers,
  undefined,
  "stickers stripped from non-stickerable item"
);

// 3. Default (free) item without attachments is dropped.
const freeOnly = decodeInventoryData(
  JSON.stringify({ items: { "9": { id: 1 } }, version: 2 })
).data;
const healedFree = JSON.parse(JSON.stringify(freeOnly));
heal(healedFree);
const isDefault = CS2Economy.get(1).isDefault;
if (isDefault) {
  expect(healedFree.items[9], undefined, "empty default item dropped");
} else {
  console.log("skip (economy id 1 is not isDefault in this dataset)");
}

// 4. Sticker-slab keychain removed.
const slab = 15200;
const withSlab = decodeInventoryData(
  JSON.stringify({
    items: { "11": { id: 7, keychains: { "0": { id: slab } } } },
    version: 2
  })
).data;
const healedSlab = JSON.parse(JSON.stringify(withSlab));
heal(healedSlab);
const keychainsAfter = healedSlab.items[11]?.keychains;
expect(
  keychainsAfter === undefined || !hasKeys(keychainsAfter),
  true,
  "sticker-slab keychain removed"
);

console.log(
  failures === 0
    ? "V9 MIGRATION VERIFY: all assertions passed"
    : `V9 MIGRATION VERIFY: ${failures} failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
