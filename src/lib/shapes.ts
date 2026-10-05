/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — zod shapes
 *
 *  Port of shared/utils/shapes.ts + api/utils/shapes.server.ts. One module so the
 *  worker (single tsconfig include) can consume both client- and server-side
 *  inventory shapes.
 *--------------------------------------------------------------------------------------------*/

import { CS2Economy, type CS2BaseInventoryItem } from "@ianlucas/cs2-lib";
import { z, type ZodObject } from "zod";
import {
  validateKeychainOffset,
  validateKeychainSeed,
  validateStickerOffset,
  validateStickerRotation,
  validateStickerWear
} from "./economy";

export const nonNegativeInt = z.number().int().nonnegative().finite().safe();
export const positiveInt = z.number().int().positive().finite().safe();
export const nonNegativeFloat = z.number().nonnegative().finite();

/**
 * Identifiers that end up in a database key or a `LIKE` pattern. Steam IDs are
 * 17 digits and Steam session/user ids are UUIDs, so 128 chars is generous;
 * the bound exists so an anonymous caller cannot push megabyte-long strings
 * into `RateLimitBucket.key` or force a full-table `LIKE`.
 */
export const userIdShape = z.string().min(1).max(128);
export const apiKeyShape = z.string().min(1).max(256);

export const optionalStickerOffset = z
  .number()
  .finite()
  .optional()
  .refine(
    (value) =>
      value === undefined || validateStickerOffset(value, undefined, undefined)
  );
export const optionalStickerRotation = z
  .number()
  .finite()
  .optional()
  .refine((value) => value === undefined || validateStickerRotation(value));
export const optionalStickerWear = z
  .number()
  .finite()
  .optional()
  .refine((value) => value === undefined || validateStickerWear(value));
export const optionalKeychainOffset = z
  .number()
  .finite()
  .optional()
  .refine((value) => value === undefined || validateKeychainOffset(value));

export const baseInventoryItemProps = {
  equipped: z.boolean().optional(),
  equippedCT: z.boolean().optional(),
  equippedT: z.boolean().optional(),
  id: nonNegativeInt.refine((id) => CS2Economy.items.has(id)),
  nameTag: z
    .string()
    .max(20)
    .optional()
    .transform((nameTag) => CS2Economy.trimNameTag(nameTag))
    .refine((nameTag) => CS2Economy.safeValidateNameTag(nameTag))
    .optional(),
  keychains: z
    .record(
      z.string(),
      z.object({
        id: nonNegativeInt,
        seed: positiveInt
          .optional()
          .refine((seed) => seed === undefined || validateKeychainSeed(seed)),
        x: z
          .number()
          .optional()
          .refine((x) => x === undefined || validateKeychainOffset(x)),
        y: z
          .number()
          .optional()
          .refine((y) => y === undefined || validateKeychainOffset(y)),
        z: z
          .number()
          .optional()
          .refine((z) => z === undefined || validateKeychainOffset(z))
      })
    )
    .optional(),
  patches: z.record(z.string(), nonNegativeInt).optional(),
  seed: positiveInt.optional(),
  statTrak: z.literal(0).optional(),
  stickers: z
    .record(
      z.string(),
      z.object({
        id: nonNegativeInt,
        rotation: optionalStickerRotation,
        wear: optionalStickerWear,
        schema: z.number().int().min(0).optional(),
        x: optionalStickerOffset,
        y: optionalStickerOffset
      })
    )
    .optional(),
  wear: nonNegativeFloat
    .optional()
    .refine((wear) => wear === undefined || CS2Economy.safeValidateWear(wear))
};

const baseServerInventoryItemProps = {
  ...baseInventoryItemProps,
  statTrak: z
    .number()
    .optional()
    .refine(
      (statTrak) =>
        statTrak === undefined || CS2Economy.safeValidateStatTrak(statTrak)
    )
};

const serverInventoryItemProps = {
  ...baseServerInventoryItemProps,
  containerId: nonNegativeInt.optional(),
  storage: z
    .record(z.string(), z.object(baseServerInventoryItemProps))
    .optional()
};

export const serverInventoryItemShape = z.object(serverInventoryItemProps);

export const serverInventoryShape = z.object({
  items: z.record(z.string(), serverInventoryItemShape),
  version: nonNegativeInt
});

export const teamShape = z.literal(0).or(z.literal(2)).or(z.literal(3));

// ---------------------------------------------------------------------------
// Client / sync shapes (from api/utils/shapes.server.ts)
// ---------------------------------------------------------------------------

const clientInventoryItemProps = {
  ...baseInventoryItemProps
};

const syncInventoryItemProps = {
  ...clientInventoryItemProps,
  storage: z
    .record(
      z.string(),
      z.object({
        ...clientInventoryItemProps
      })
    )
    .optional()
};

export const baseStickerSlabId = 15200;

function allowed({
  id,
  nameTag,
  stickers,
  keychains
}: Pick<CS2BaseInventoryItem, "id" | "nameTag" | "stickers" | "keychains">) {
  // Free (default) items can be stored if they have a nametag or stickers or
  // keychains. v9 renamed the economy flag from `free` to `isDefault`.
  if (
    CS2Economy.getById(id).isDefault &&
    nameTag === undefined &&
    stickers === undefined &&
    keychains === undefined
  ) {
    return false;
  }
  if (keychains !== undefined) {
    for (const { id } of Object.values(keychains)) {
      if (id === baseStickerSlabId) {
        return false;
      }
    }
  }
  return true;
}

function refine(
  inventoryItem: z.infer<ZodObject<typeof syncInventoryItemProps>>
) {
  if (!allowed(inventoryItem)) {
    return false;
  }
  if (inventoryItem.storage !== undefined) {
    for (const item of Object.values(inventoryItem.storage)) {
      if (!allowed(item)) {
        return false;
      }
    }
  }
  return true;
}

export const clientInventoryItemShape = z
  .object(clientInventoryItemProps)
  .refine(refine);

export const syncInventoryItemShape = z
  .object(syncInventoryItemProps)
  .refine(refine);

export const clientInventoryShape = z.object({
  items: z.record(z.string(), clientInventoryItemShape),
  version: nonNegativeInt
});

export const syncInventoryShape = z.object({
  items: z.record(z.string(), syncInventoryItemShape),
  version: nonNegativeInt
});

export const itemEditorAttributesShape = z
  .object(clientInventoryItemProps)
  .pick({
    keychains: true,
    nameTag: true,
    patches: true,
    seed: true,
    stickers: true,
    wear: true
  })
  .extend({
    statTrak: z.boolean().optional()
  });

export type SyncInventoryItemShape = z.infer<typeof syncInventoryItemShape>;
export type SyncInventoryShape = z.infer<typeof syncInventoryShape>;