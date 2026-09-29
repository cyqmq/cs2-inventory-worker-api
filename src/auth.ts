/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — authentication helpers
 *
 *  Port of api/auth.server.ts + the two strategies (api-strategy, steam-strategy)
 *  without remix-auth/react-router. requireUser returns a JSON 401 instead of
 *  redirecting to /sign-in.
 *--------------------------------------------------------------------------------------------*/

import { fail } from "@ianlucas/cs2-lib";
import { z } from "zod";
import { getSession } from "./lib/session";
import { SteamOpenID, fetchSteamUserInput } from "./lib/steam";
import { unauthorized } from "./lib/responses";
import {
  clearAuthTokens,
  clearExpiredAuthTokens,
  getAuthTokenDetails
} from "./models/api-auth-token";
import { steamCallbackUrl } from "./models/rule";
import { findUniqueUser, upsertUser } from "./models/user";

export async function getUserIdFromRequest(request: Request) {
  const session = await getSession(request.headers.get("cookie"));
  const userId = session.get("userId");
  if (typeof userId !== "string") {
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

/** API strategy: ?token=<auth-token> → user (token consumed in the process). */
export async function authenticateApi(request: Request) {
  const url = new URL(request.url);
  const token = z.string().parse(url.searchParams.get("token"));
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
  const returnUrl = await steamCallbackUrl.get();
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