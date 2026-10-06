/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — authentication helpers
 *
 *  Port of api/auth.server.ts + the two strategies (api-strategy, steam-strategy)
 *  without remix-auth/react-router. requireUser returns a JSON 401 instead of
 *  redirecting to /sign-in.
 *--------------------------------------------------------------------------------------------*/

import { fail } from "@ianlucas/cs2-lib";
import { z } from "zod";
import { getSession, getSessionId, SESSION_ID_KEY, type WorkerSession } from "./lib/session";
import { createSession, isSessionLive } from "./lib/session-store";
import { SteamOpenID, fetchSteamUserInput, resolveSteamCallbackUrl } from "./lib/steam";
import { unauthorized } from "./lib/responses";
import {
  clearAuthTokens,
  clearExpiredAuthTokens,
  getAuthTokenDetails
} from "./models/api-auth-token";
import { findUniqueUser, upsertUser } from "./models/user";

export async function getUserIdFromRequest(request: Request) {
  const session = await getSession(request.headers.get("cookie"));
  const userId = session.get("userId");
  if (typeof userId !== "string") {
    return undefined;
  }
  // A valid HMAC is not enough: the payload is self-contained, so a cookie that
  // was signed and then revoked (or has since expired server-side) would still
  // verify. The `sid` row is what makes sign-out actually take effect.
  const sid = getSessionId(session);
  if (sid === undefined) {
    return undefined;
  }
  if (!(await isSessionLive(sid))) {
    return undefined;
  }
  return userId;
}

export async function findRequestUser(request: Request) {
  const userId = await getUserIdFromRequest(request);
  if (userId === undefined) {
    return undefined;
  }
  return await findUniqueUser(userId);
}

export async function requireUser(request: Request) {
  const user = await findRequestUser(request);
  if (user === undefined) {
    throw unauthorized();
  }
  return user;
}

/**
 * Stamp a fresh revocation id into a session and persist it, so the cookie that
 * is about to be committed names a row in `Session`.
 *
 * Every sign-in path must go through this. Re-using an existing `sid` would
 * mean the previous cookie for the same browser also becomes revocable, which
 * is fine, but signing in on a second device has to mint a *new* one so that
 * signing out on the second device does not lock out the first.
 */
export async function startSession(session: WorkerSession): Promise<void> {
  const userId = session.get("userId");
  if (typeof userId !== "string") {
    return;
  }
  session.set(SESSION_ID_KEY, await createSession(userId));
}

/** API strategy: ?token=<auth-token> → user (token consumed in the process). */
export async function authenticateApi(request: Request) {
  const url = new URL(request.url);
  const token = z.string().min(1).max(128).parse(url.searchParams.get("token"));
  const { details, valid } = await getAuthTokenDetails(token);
  if (details === undefined) {
    fail("Invalid token.");
  }
  if (!valid) {
    await clearExpiredAuthTokens(details!.userId);
    fail("Expired token.");
  }
  await clearAuthTokens(details!.userId);
  return await upsertUser(await fetchSteamUserInput(details!.userId));
}

/** Steam strategy: validates the OpenID callback or returns the auth URL. */
export async function authenticateSteam(request: Request) {
  const returnUrl = resolveSteamCallbackUrl(request);
  const steamOpenID = new SteamOpenID(returnUrl, request);
  if (steamOpenID.shouldValidate()) {
    const userID = await steamOpenID.validate();
    return {
      type: "user" as const,
      userId: await upsertUser(await fetchSteamUserInput(userID))
    };
  }
  return { type: "redirect" as const, authUrl: steamOpenID.getAuthUrl() };
}