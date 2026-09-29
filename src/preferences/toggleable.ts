/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — toggleable preferences
 *  Port of api/preferences/toggleable.server.ts.
 *--------------------------------------------------------------------------------------------*/

import type { WorkerSession } from "../lib/session";

export async function getToggleable(session: WorkerSession) {
  return {
    hideFilters: session.get("hideFilters") === "true" || false,
    hideFreeItems: session.get("hideFreeItems") === "true" || false,
    hideNewItemLabel: session.get("hideNewItemLabel") === "true" || false,
    prefer2dStickerEditor:
      session.get("prefer2dStickerEditor") === "true" || false,
    statsForNerds: session.get("statsForNerds") === "true" || false
  };
}