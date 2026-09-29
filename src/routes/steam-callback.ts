/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /sign-in/steam/callback
 *
 *  Steam OpenID dual-mode flow (port of the remix-auth Steam strategy usage in
 *  the original root layout):
 *    - no `openid.mode=id_res` → 302 to the Steam OpenID provider
 *    - valid callback → validate → upsert user → session cookie →
 *      307 to FRONTEND_URL ?? "/api/action/preferences"
 *    - any Error → 302 to FRONTEND_URL ?? "/"
 *  Response-typed errors (middleware 308 redirects, 401s) pass through.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { authenticateSteam } from "../auth";
import { middleware } from "../middleware";
import { methodNotAllowed } from "../lib/responses";
import { frontendRedirect } from "../lib/redirect";
import { commitSession, getSession } from "../lib/session";

export async function steamCallback(c: Context) {
  const request = c.req.raw;
  try {
    await middleware(request);
    if (request.method !== "GET") {
      throw methodNotAllowed;
    }
    const result = await authenticateSteam(request);
    if (result.type === "redirect") {
      return new Response(null, {
        status: 302,
        headers: { Location: result.authUrl }
      });
    }
    const session = await getSession(request.headers.get("cookie"));
    session.set("userId", result.userId);
    return frontendRedirect("/api/action/preferences", 307, {
      "Set-Cookie": await commitSession(session)
    });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    return frontendRedirect("/", 302);
  }
}