/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — POST /api/sign-in, GET /api/sign-in/callback
 *
 *  Port of api.sign-in._index.tsx + api.sign-in.callback._index.tsx.
 *  The callback performs the "api" strategy (validates ?token=, consumes it and
 *  upserts the user) then commits the session cookie and redirects on to the
 *  preferences action (same flow as the original).
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { z } from "zod";
import { authenticateApi } from "../auth";
import { middleware } from "../middleware";
import { generateAuthToken } from "../models/api-auth-token";
import { API_AUTH_SCOPE, isApiKeyValid } from "../models/api-credential";
import { existsUser } from "../models/user";
import { badRequest, methodNotAllowed, unauthorizedResponse } from "../lib/responses";
import { frontendRedirect } from "../lib/redirect";
import { commitSession, getSession } from "../lib/session";

export async function signIn(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  const { apiKey, userId } = z
    .object({
      apiKey: z.string(),
      userId: z.string()
    })
    .parse(await request.json());

  if (!(await isApiKeyValid(apiKey, [API_AUTH_SCOPE]))) {
    throw unauthorizedResponse;
  }

  if (!(await existsUser(userId))) {
    throw badRequest;
  }

  return c.json({
    token: await generateAuthToken({ apiKey, userId })
  });
}

export async function signInCallback(c: Context) {
  const request = c.req.raw;
  try {
    await middleware(request);
    if (request.method !== "GET") {
      throw methodNotAllowed;
    }
    const userId = await authenticateApi(request);
    const session = await getSession(request.headers.get("cookie"));
    session.set("userId", userId);
    return frontendRedirect("/api/action/preferences", 307, {
      "Set-Cookie": await commitSession(session)
    });
  } catch (error) {
    if (error instanceof Error) {
      // Token invalid / expired / missing — back to the start.
      return frontendRedirect("/", 302);
    }
    throw error;
  }
}