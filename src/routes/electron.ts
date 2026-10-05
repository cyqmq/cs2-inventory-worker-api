/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/auth/electron + GET /api/auth/electron-config
 *  Port of api.auth.electron._index.tsx + api.auth.electron-config._index.tsx.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { getRuntime } from "../env";
import { middleware } from "../middleware";
import { upsertUser } from "../models/user";
import { startSession } from "../auth";
import { badRequest, methodNotAllowed } from "../lib/responses";
import { clientShardKey } from "../lib/rate-limit-key";
import { ELECTRON_AUTH_RATE_LIMIT, enforceRateLimit } from "../lib/token-bucket";
import { commitSession, getSession } from "../lib/session";

export async function electronAuth(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  // This mints a session and can create a user row, so it is the most valuable
  // unauthenticated target in the app: the only thing standing between an
  // attacker and a stream of sessions is knowledge of ELECTRON_AUTH_SECRET.
  // Throttled on the client shard so the bucket table cannot be grown by
  // rotating addresses.
  await enforceRateLimit(
    clientShardKey(request, "electron-auth"),
    ELECTRON_AUTH_RATE_LIMIT
  );
  const { searchParams } = new URL(request.url);
  const steamId = searchParams.get("steamId");
  const secret = searchParams.get("secret");
  const nickname = searchParams.get("nickname") || "Player";
  const avatarUrl = searchParams.get("avatar") || "";

  if (!steamId || !secret || secret !== getRuntime().env.ELECTRON_AUTH_SECRET) {
    throw badRequest;
  }

  const userId = await upsertUser({
    steamID: steamId,
    nickname,
    avatar: { medium: avatarUrl }
  });
  const session = await getSession(request.headers.get("cookie"));
  session.set("userId", userId);
  await startSession(session);

  return c.json({
    sessionCookie: await commitSession(session)
  });
}

export async function electronConfig(c: Context) {
  const request = c.req.raw;
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  if (!secret || secret !== getRuntime().env.ELECTRON_AUTH_SECRET) {
    throw badRequest;
  }
  return c.json({
    steamApiKey: getRuntime().env.STEAM_API_KEY || ""
  });
}