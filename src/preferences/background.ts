/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — background preference
 *  Port of api/preferences/background.server.ts.
 *--------------------------------------------------------------------------------------------*/

import type { WorkerSession } from "../lib/session";
import { backgroundValues } from "../lib/backgrounds";

export const defaultBackground = "sirocco_night";

export function isValidBackground(background: string) {
  if (background.length === 0) {
    return true;
  }
  return backgroundValues.includes(background);
}

export function transformBackground(background: string) {
  return background === "" ? null : background;
}

export function getSessionBackground(session: WorkerSession) {
  return session.get("background") as string | null;
}

export async function getBackground(session: WorkerSession) {
  const background = getSessionBackground(session);
  return { background };
}