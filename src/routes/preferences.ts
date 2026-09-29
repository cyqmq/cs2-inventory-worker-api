/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET/POST /api/action/preferences
 *  Port of api.action.preferences._index.tsx. Both endpoints end with a 302 to
 *  FRONTEND_URL ?? "/" like react-router's redirect("/").
 *--------------------------------------------------------------------------------------------*/

import { z } from "zod";
import type { Context } from "hono";
import { getUserIdFromRequest } from "../auth";
import { middleware } from "../middleware";
import { setUserPreferences, getUserPreferences } from "../models/user-preference";
import {
  isValidBackground,
  transformBackground
} from "../preferences/background";
import { isValidLanguage } from "../preferences/language";
import { methodNotAllowed } from "../lib/responses";
import { frontendRedirect } from "../lib/redirect";
import { assignToSession, commitSession, getSession } from "../lib/session";

export async function preferences(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method === "GET") {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return frontendRedirect("/", 302);
    }
    const session = await getSession(request.headers.get("Cookie"));
    assignToSession(
      session,
      await getUserPreferences(userId, [
        "background",
        "hideFilters",
        "hideFreeItems",
        "hideNewItemLabel",
        "language",
        "prefer2dStickerEditor",
        "statsForNerds"
      ])
    );
    return frontendRedirect("/", 302, {
      "Set-Cookie": await commitSession(session)
    });
  }
  if (request.method === "POST") {
    const userId = await getUserIdFromRequest(request);
    const formPreferences = z
      .object({
        background: z
          .string()
          .refine(isValidBackground)
          .transform(transformBackground),
        language: z.string().refine(isValidLanguage),
        statsForNerds: z.literal("true").or(z.literal("false")),
        hideFreeItems: z.literal("true").or(z.literal("false")),
        hideFilters: z.literal("true").or(z.literal("false")),
        hideNewItemLabel: z.literal("true").or(z.literal("false")),
        prefer2dStickerEditor: z.literal("true").or(z.literal("false"))
      })
      .parse(Object.fromEntries(await request.formData()));
    if (userId) {
      await setUserPreferences(userId, formPreferences);
    }
    const session = await getSession(request.headers.get("Cookie"));
    assignToSession(session, formPreferences);
    return frontendRedirect("/", 302, {
      "Set-Cookie": await commitSession(session)
    });
  }
  throw methodNotAllowed;
}