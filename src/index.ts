/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — Cloudflare Worker entry point
 *
 *  Hono app wiring every contract endpoint, CORS reflection, 404/error handling.
 *  `env` bindings are captured by setRuntime() before each request is dispatched
 *  (module-level code cannot reach them).
 *--------------------------------------------------------------------------------------------*/

import { Hono } from "hono";
import { getRuntime, setRuntime, type Env } from "./env";
import { healthz } from "./routes/healthz";
import { init } from "./routes/init";
import { signIn, signInCallback } from "./routes/sign-in";
import { signOut } from "./routes/sign-out";
import { steamCallback } from "./routes/steam-callback";
import { electronAuth, electronConfig } from "./routes/electron";
import { users } from "./routes/users";
import { user, userBasic } from "./routes/user";
import { inventory, equippedV4, equippedV5 } from "./routes/inventory";
import { addItem } from "./routes/add-item";
import { addContainer } from "./routes/add-container";
import { incrementItemStatTrak } from "./routes/increment-item-stattrak";
import { consumeItemSpray } from "./routes/consume-item-spray";
import {
  importInspectLink,
  resetInventory,
  resync,
  sync,
  unlockCase
} from "./routes/actions";
import { preferences } from "./routes/preferences";

export const app = new Hono();

// ---------------------------------------------------------------------------
// CORS — reflect the origin when allowed (exact FRONTEND_URL/CORS_ORIGINS match
// or a TRUSTED_HOSTNAMES hostname match) so a separate frontend can call in with
// credentials. Headers are applied to normal responses and re-applied to error
// responses in onError.
// ---------------------------------------------------------------------------

function originAllowedFor(origin: string, env: Env): boolean {
  const allowed = new Set<string>();
  const add = (value: string | undefined) => {
    if (value === undefined) {
      return;
    }
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        allowed.add(trimmed.replace(/\/+$/, ""));
      }
    }
  };
  add(env.FRONTEND_URL);
  add(env.CORS_ORIGINS);
  if (allowed.has(origin.replace(/\/+$/, ""))) {
    return true;
  }
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  // Loopback origins are trusted only when the deployment opts in. Reflecting
  // them unconditionally would let *any* process that can bind a loopback port
  // on the victim's machine (a malicious postinstall script, another Electron
  // app, a stray dev server) read the API with the victim's cookies, because
  // the reflected origin is sent with Allow-Credentials: true. Dev convenience
  // is not worth that in a deployment, so it is an explicit switch.
  if (localhostOriginsTrusted(env)) {
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return true;
    }
  }
  const trusted = (env.TRUSTED_HOSTNAMES ?? "")
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter((hostname) => hostname.length > 0);
  return trusted.some((trustedHostname) =>
    trustedHostname === hostname.toLowerCase() ||
    hostname.toLowerCase().endsWith(
      trustedHostname.startsWith(".") ? trustedHostname : `.${trustedHostname}`
    )
  );
}

function applyCorsHeaders(headers: Headers, origin: string) {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function allowedOriginHeader(c: { req: { header(name: string): string | undefined } }): string | undefined {
  const origin = c.req.header("Origin");
  if (origin === undefined || origin === "null") {
    return undefined;
  }
  return originAllowedFor(origin, getRuntime().env) ? origin : undefined;
}

/**
 * Loopback CORS origins are trusted when TRUST_LOCALHOST_ORIGINS is "true",
 * or when the deployment named no frontend at all (a local `wrangler dev`
 * setup, where the Vite proxy/frontend and the API share 127.0.0.1 anyway).
 */
export function localhostOriginsTrusted(env: Env): boolean {
  const explicit = (env.TRUST_LOCALHOST_ORIGINS ?? "").trim().toLowerCase();
  if (explicit === "true") {
    return true;
  }
  if (explicit === "false") {
    return false;
  }
  const hasConfiguredFrontend =
    (env.FRONTEND_URL ?? "").trim().length > 0 ||
    (env.CORS_ORIGINS ?? "").trim().length > 0;
  return !hasConfiguredFrontend;
}

/**
 * Baseline hardening for every response. `no-store` matters most on the
 * user-scoped routes (/api/init, /api/action/*, /api/user/*): they carry
 * per-session data and must never be written to a shared cache.
 */
function applySecurityHeaders(headers: Headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "no-store");
}

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    const origin = allowedOriginHeader(c);
    const headers = new Headers();
    if (origin !== undefined) {
      applyCorsHeaders(headers, origin);
    }
    applySecurityHeaders(headers);
    return c.newResponse(null, { status: 204, headers });
  }
  let res: Response;
  try {
    await next();
    res = c.res;
  } catch (error) {
    // Hono 4.13's compose() only routes `Error` instances to onError, so a
    // thrown Response (`throw badRequest`, `throw methodNotAllowed`, the
    // redirects from middleware()) would otherwise escape to the runtime and
    // surface as a 500. Catch and return it here instead, re-applying the CORS
    // headers so error responses behave like normal ones.
    if (!(error instanceof Response)) {
      throw error;
    }
    res = error;
  }
  const origin = allowedOriginHeader(c);
  if (origin !== undefined) {
    applyCorsHeaders(res.headers, origin);
  }
  applySecurityHeaders(res.headers);
  return res;
});

// ---------------------------------------------------------------------------
// Routes (registered with app.all; every handler enforces its own method to
// reproduce the original 405s).
// ---------------------------------------------------------------------------

app.all("/healthz", healthz);
app.all("/api/init", init);
app.all("/api/sign-in", signIn);
app.all("/api/sign-in/callback", signInCallback);
app.all("/sign-in/steam/callback", steamCallback);
app.all("/sign-out", signOut);
app.all("/api/auth/electron", electronAuth);
app.all("/api/auth/electron-config", electronConfig);
app.all("/api/users", users);
// Registered before /api/user/:userId; the two never overlap (basic/ has an
// extra path segment), the order is just for readability.
app.all("/api/user/basic/:userId", userBasic);
app.all("/api/user/:userId", user);
app.all("/api/add-item", addItem);
app.all("/api/add-container", addContainer);
app.all("/api/increment-item-stattrak", incrementItemStatTrak);
app.all("/api/consume-item-spray", consumeItemSpray);
app.all("/api/action/sync", sync);
app.all("/api/action/resync", resync);
app.all("/api/action/reset-inventory", resetInventory);
app.all("/api/action/unlock-case", unlockCase);
app.all("/api/action/import-inspect-link", importInspectLink);
app.all("/api/action/preferences", preferences);
app.all("/api/inventory/*", inventory);
app.all("/api/equipped/v4/*", equippedV4);
app.all("/api/equipped/v5/*", equippedV5);

// Hono v4 wildcard routes match but do not populate params; the handlers above
// read the userId from c.req.path instead.

app.notFound((c) =>
  c.json(
    {
      message:
        "Resource not found, please refer to https://github.com/ianlucas/cs2-inventory-simulator/blob/main/docs/api.md."
    },
    404
  )
);

// Error handler (Hono 4.13 only delivers `Error` instances here — thrown
// Responses are handled by the CORS middleware above — but keep the Response
// branch as a defensive fallback in case that changes). Zod errors become a
// friendly 400, everything else a 500.
app.onError((error, c) => {
  if (error instanceof Response) {
    const origin = allowedOriginHeader(c);
    if (origin !== undefined) {
      const headers = new Headers(error.headers);
      applyCorsHeaders(headers, origin);
      return new Response(error.body, {
        status: error.status,
        statusText: error.statusText,
        headers
      });
    }
    return error;
  }
  let errorMessage = "Internal server error";
  let logError = true;
  let statusCode = 500;
  if (error instanceof Error && error.name === "ZodError") {
    // A bare ZodError serializes to just `ZodError` under workerd, so a 400 is
    // impossible to diagnose from the logs. Log the individual issues.
    const issues = (error as { issues?: unknown }).issues;
    console.log(
      "[ZodError] ",
      issues !== undefined ? JSON.stringify(issues) : error
    );
    errorMessage =
      "Please check this endpoint's documentation for the correct request parameters.";
    logError = false;
    statusCode = 400;
  }
  if (logError) {
    console.error(error);
  }
  return c.json({ error: errorMessage }, statusCode as 400 | 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    setRuntime(env);
    return app.fetch(request, env, ctx);
  }
};