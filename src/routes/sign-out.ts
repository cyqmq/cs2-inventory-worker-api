/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /sign-out
 *
 *  Port of app/routes/sign-out._index.tsx. Two halves, and both are needed:
 *    1. Stamp `revokedAt` on the `Session` row (migration 0003). This is the part
 *       that actually revokes — the cookie is a self-contained signed blob, so
 *       overwriting it in the browser never stopped a replay.
 *    2. Overwrite the cookie with an expired one, so the browser stops sending it.
 *
 *  The frontend's sign-out route redirects here (app/routes/sign-out._index.tsx →
 *  `${apiBase}/sign-out`), so this endpoint must exist or the button lands on the
 *  404 page with the session still alive.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { middleware } from "../middleware";
import { methodNotAllowed } from "../lib/responses";
import { frontendRedirect } from "../lib/redirect";
import { destroySession, getSession, getSessionId } from "../lib/session";
import { revokeSession } from "../lib/session-store";

export const SignOutUrl = "/sign-out";

export async function signOut(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  const session = await getSession(request.headers.get("cookie"));
  const userId = session.get("userId");
  const sid = getSessionId(session);
  if (typeof userId === "string" && sid !== undefined) {
    // Narrow, not per-user: signing out of one browser should not sign the same
    // account out everywhere, so only the presented sid is stamped.
    await revokeSession(userId, Date.now(), { sid });
  }
  return frontendRedirect("/", 302, {
    "Set-Cookie": await destroySession(session)
  });
}