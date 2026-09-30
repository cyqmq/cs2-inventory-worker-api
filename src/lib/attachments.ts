/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — attachment (sticker / patch) limit helpers
 *
 *  Port of app/utils/attachments.ts. A rule value below zero means "use the
 *  game's hard maximum", anything else is clamped down to it.
 *--------------------------------------------------------------------------------------------*/

export function resolveMaxAttachments(value: number, hardMax: number) {
  return value < 0 ? hardMax : Math.min(value, hardMax);
}

/**
 * `next` may exceed `max` only when the item already carries more than the
 * current limit — that keeps lowering the rule from destroying existing
 * attachments while still blocking new ones.
 */
export function isAttachmentCountAllowed({
  current,
  max,
  next
}: {
  current: number;
  max: number;
  next: number;
}) {
  return next <= Math.max(max, current);
}
