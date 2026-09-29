/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — economy validation helpers (mirrors shared/utils/economy.ts,
 *  server-safe subset).
 *--------------------------------------------------------------------------------------------*/

import {
  CS2_MAX_KEYCHAIN_SEED,
  CS2_MAX_STICKER_WEAR,
  CS2_MAX_STICKERS,
  CS2_MIN_KEYCHAIN_SEED,
  CS2_MIN_STICKER_ROTATION,
  CS2_MIN_STICKER_WEAR,
  CS2_STICKER_OFFSET_FACTOR,
  CS2_STICKER_WEAR_FACTOR,
  CS2_WEAR_FACTOR,
  isFactorPrecise,
  validateStickerRotation
} from "@ianlucas/cs2-lib";
import { CS2_PREVIEW_URL, isCommandInspect, isSteamInspectLink } from "@ianlucas/cs2-lib-inspect";

export const baseStickerSlabId = 15200;

export const minKeychainOffset = -100;
export const maxKeychainOffset = 100;
export const keychainOffsetFactor = 0.001;

export function validateStickerWear(wear: number) {
  return (
    isFactorPrecise(wear, CS2_STICKER_WEAR_FACTOR) &&
    wear >= CS2_MIN_STICKER_WEAR &&
    wear <= CS2_MAX_STICKER_WEAR
  );
}

export function validateStickerOffset(
  offset: number,
  min: number | undefined,
  max: number | undefined
) {
  return (
    isFactorPrecise(offset, CS2_STICKER_OFFSET_FACTOR) &&
    (min === undefined || offset >= min) &&
    (max === undefined || offset <= max)
  );
}

export function validateKeychainOffset(offset: number) {
  return (
    isFactorPrecise(offset, keychainOffsetFactor) &&
    offset >= minKeychainOffset &&
    offset <= maxKeychainOffset
  );
}

export function validateStickerSchema(schema: number, itemCount?: number) {
  return (
    Number.isInteger(schema) &&
    schema >= 0 &&
    schema <= (itemCount ?? CS2_MAX_STICKERS) - 1
  );
}

export function validateKeychainSeed(seed: number) {
  return (
    Number.isInteger(seed) &&
    seed >= CS2_MIN_KEYCHAIN_SEED &&
    seed <= CS2_MAX_KEYCHAIN_SEED
  );
}

export function isValidInspectLink(link: string) {
  return (
    isCommandInspect(link) ||
    isSteamInspectLink(link) ||
    link.startsWith(CS2_PREVIEW_URL)
  );
}

export { validateStickerRotation };

// Referenced by import-inspect-link to keep float precision stable.
export { CS2_STICKER_OFFSET_FACTOR, CS2_WEAR_FACTOR };