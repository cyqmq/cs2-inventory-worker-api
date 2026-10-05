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
import { authenticateApi, startSession } from "../auth";
import { middleware } from "../middleware";
import { generateAuthToken } from "../models/api-auth-token";
import { API_AUTH_SCOPE, isApiKeyValid } from "../models/api-credential";
import { existsUser } from "../models/user";
import { badRequest, methodNotAllowed, unauthorizedResponse } from "../lib/responses";
import { apiKeyShape, userIdShape } from "../lib/shapes";
import { frontendRedirect } from "../lib/redirect";
import { clientShardKey } from "../lib/rate-limit-key";
import { SIGN_IN_RATE_LIMIT, enforceRateLimit } from "../lib/token-bucket";
import { commitSession, getSession } from "../lib/session";

export async function signIn(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  if (request.method !== "POST") {
    throw methodNotAllowed;
  }
  // This is the api-key guessing oracle: a wrong key costs a single indexed
  // lookup on `ApiCredential`, so an unthrottled loop is cheap to run and
  // expensive to notice. The credential is in the body, not a header, and the
  // caller is anonymous at this point, so the bucket is shard-keyed rather than
  // keyed on the key being guessed (which would let an attacker pick its own
  // bucket per attempt and make the limit decorative).
  await enforceRateLimit(
    clientShardKey(request, "sign-in"),
    SIGN_IN_RATE_LIMIT
  );
  const { apiKey, userId } = z
    .object({
      apiKey: apiKeyShape,
      userId: userIdShape
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
    // `?token=` is a single-use auth token, so replaying guesses is only worth
    // as long as the token is unguessable; this bounds the search. Shard-keyed
    // for the same reason as above — keying on the token would hand every
    // attempt its own fresh bucket. Thrown as a Response, so the catch below
    // re-throws it and the 429 reaches the client instead of becoming a
    // redirect that looks like a normal expired-token bounce.
    await enforceRateLimit(
      clientShardKey(request, "sign-in-callback"),
      SIGN_IN_RATE_LIMIT
    );
    const userId = await authenticateApi(request);
    const session = await getSession(request.headers.get("cookie"));
    session.set("userId", userId);
    await startSession(session);
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