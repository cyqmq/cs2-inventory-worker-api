/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — runtime environment
 *
 *  Cloudflare Workers injects bindings as the `env` argument of the fetch
 *  handler. Module-level code cannot reach them, so every request stores them
 *  here before dispatching. All feature modules read settings through
 *  `getRuntime()` / `getRuntime().env` instead of `process.env`.
 *--------------------------------------------------------------------------------------------*/

/** Hyperdrive binding (PostgreSQL over Hyperdrive). */
export interface HyperdriveBinding {
  connectionString: string;
}

export interface Env {
  /** D1 (SQLite). Preferred. Mutually exclusive with HYPERDRIVE. */
  DB?: D1Database;
  /** Hyperdrive (PostgreSQL). Used when DB is absent. */
  HYPERDRIVE?: HyperdriveBinding;

  SESSION_SECRET: string;
  ELECTRON_AUTH_SECRET: string;

  /** Configurable rules fall back to these env values. */
  STEAM_API_KEY?: string;
  STEAM_CALLBACK_URL?: string;
  VIEWER_KEY?: string;

  /** Frontend origin — auth redirects + CORS. */
  FRONTEND_URL?: string;
  /** Extra CORS origins (comma separated). */
  CORS_ORIGINS?: string;
  /**
   * "true"/"false" pins whether loopback origins (localhost / 127.0.0.1) are
   * reflected by the CORS check. Unset means: trust them only when no frontend
   * origin is configured at all (plain local `wrangler dev`).
   */
  TRUST_LOCALHOST_ORIGINS?: string;
  /** Comma separated hostnames trusted for the 3D viewer origin check. */
  TRUSTED_HOSTNAMES?: string;

  ASSETS_BASE_URL?: string;
  VIEWER_ASSETS_BASE_URL?: string;
  VIEWER_EMBED_URL?: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
  SOURCE_COMMIT?: string;

  /** "false" disables the Secure flag on the session cookie. */
  SESSION_SECURE_COOKIE?: string;
  /** Overrides the session cookie SameSite attribute (defaults to "Lax"). */
  SESSION_COOKIE_SAMESITE?: string;
}

interface Runtime {
  env: Env;
}

let runtime: Runtime | undefined;

export function setRuntime(env: Env): Runtime {
  runtime = { env };
  return runtime;
}

export function getRuntime(): Runtime {
  if (runtime === undefined) {
    throw new Error("Runtime environment not set. Did you call setRuntime(env)?");
  }
  return runtime;
}

/** Utility: non-empty string variant of an env value. */
export function nonEmptyEnvString(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}