/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — request middleware
 *
 *  Port of api/middleware.server.ts + the three middlewares it composes
 *  (remove-trailing-dots, remove-trailing-slashes, is-valid-api-request).
 *  Redirects use 308 (Permanent Redirect) instead of react-router's 302.
 *--------------------------------------------------------------------------------------------*/

import { z } from "zod";
import { getUserIdFromRequest } from "./auth";
import { ensureEconomyLoaded } from "./lib/economy-loader";
import { unauthorized } from "./lib/responses";
import { migrateInventory } from "./models/migrate-inventory";
import { isApiKeyValid } from "./models/api-credential";
import { touchLastSeen } from "./models/user";

export function redirectResponse(url: string, status = 308) {
  return Response.redirect(url, status);
}

export async function removeTrailingDots(request: Request) {
  const url = new URL(request.url);
  if (url.hostname.endsWith(".")) {
    url.hostname = url.hostname.slice(0, -1);
    throw redirectResponse(url.toString());
  }
}

export async function removeTrailingSlashes(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/") && url.pathname !== "/") {
    const target = new URL(
      url.pathname.slice(0, -1) + url.search,
      request.url
    );
    throw redirectResponse(target.toString());
  }
}

export async function isValidApiRequest(request: Request, scope?: string[]) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader === null) {
    // Missing credentials must be 401, not a ZodError-driven 400. The Zod
    // branch below still catches a present-but-malformed header.
    throw unauthorized();
  }
  const apiKey = z.string().parse(authHeader.replace("Bearer ", ""));
  if (!(await isApiKeyValid(apiKey, scope))) {
    throw unauthorized();
  }
}

export async function middleware(request: Request, userId?: string) {
  userId ??= await getUserIdFromRequest(request);
  await removeTrailingDots(request);
  await removeTrailingSlashes(request);
  ensureEconomyLoaded();
  await migrateInventory(userId);
  if (userId !== undefined) {
    await touchLastSeen(userId);
  }
}