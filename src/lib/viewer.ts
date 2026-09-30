/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — 3D viewer availability
 *
 *  Port of app/data/viewer.server.ts and app/api/data/viewer.server.ts. Upstream
 *  keeps the viewer's catalog and the public per-origin quota warm with two
 *  self-rescheduling loops; a Worker isolate cannot run timers between requests,
 *  so the same two states are kept in module scope and refreshed lazily (with a
 *  TTL) from the requests that need them. The verdicts, the fail-closed order and
 *  the reason names are identical.
 *--------------------------------------------------------------------------------------------*/

import { getRuntime } from "../env";
import { viewerEnabled, viewerKey, steamCallbackUrl } from "../models/rule";

export const DEFAULT_VIEWER_EMBED_URL = "https://3d.cstrike.app/view";

export interface ViewerCatalog {
  maxId: number;
  holes: [number, number][];
}

/** Why the server withholds the viewer, in priority order when several apply. */
export type ViewerServerReason =
  | "disabled"
  | "pending"
  | "catalog-failed"
  | "rate-limit-check-failed"
  | "rate-limit-check-throttled"
  | "rate-limit-exhausted";

export type ViewerServerStatus =
  | { available: true; catalog: ViewerCatalog }
  | { available: false; reason: ViewerServerReason; retryAt?: number };

export const VIEWER_FETCH_TIMEOUT_MS = 5_000;
export const VIEWER_CATALOG_REFRESH_MS = 300_000;
export const VIEWER_CATALOG_RETRY_MS = 30_000;
export const VIEWER_RATE_LIMIT_REFRESH_MS = 60_000;
export const VIEWER_RATE_LIMIT_RETRY_MS = 30_000;

// Floor for waits derived from the viewer's clock (Retry-After, resetAt), so a
// skewed or already-passed deadline cannot clear the block immediately.
export const VIEWER_RATE_LIMIT_MIN_WAIT_MS = 5_000;

// The share of the public per-origin quota left for the viewer's own traffic;
// at or below it the server stops handing out 3D.
export const VIEWER_MIN_REMAINING_RATIO = 0.1;

// How long a request waits for the very first catalog fetch before answering
// `pending` (a Worker must not hold a request open for a slow third party).
const VIEWER_CATALOG_COLD_WAIT_MS = 1_500;

type CatalogState =
  | { status: "pending" }
  | { status: "ok"; catalog: ViewerCatalog; expiresAt: number }
  | { status: "failed"; expiresAt: number };

type RateLimitBlockReason = Extract<
  ViewerServerReason,
  `rate-limit-${string}`
>;

type RateLimitState =
  | { status: "pending" }
  | { status: "ok"; expiresAt: number }
  | { status: "blocked"; reason: RateLimitBlockReason; retryAt: number };

interface RateLimitResponse {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
}

let catalogState: CatalogState = { status: "pending" };
let rateLimitState: RateLimitState = { status: "pending" };
let catalogInFlight: Promise<void> | undefined;
let rateLimitInFlight: Promise<void> | undefined;

function getViewerOrigin() {
  const embedUrl = getRuntime().env.VIEWER_EMBED_URL;
  return new URL(embedUrl || DEFAULT_VIEWER_EMBED_URL).origin;
}

/**
 * Hostnames allowed to use the viewer without a partner key. `localhost` and
 * `127.0.0.1` are always trusted; `cstrike.app` is the viewer's own site.
 */
function isTrustedHostname(hostname: string) {
  if (hostname === "cstrike.app" || hostname.endsWith(".cstrike.app")) {
    return true;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return true;
  }
  const value = getRuntime().env.TRUSTED_HOSTNAMES;
  if (value === undefined) {
    return false;
  }
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .some(
      (entry) =>
        hostname.toLowerCase() === entry ||
        hostname.toLowerCase().endsWith(entry.startsWith(".") ? entry : `.${entry}`)
    );
}

function parseCatalog(data: unknown): ViewerCatalog | undefined {
  const catalog = data as Partial<ViewerCatalog> | null;
  if (
    typeof catalog?.maxId !== "number" ||
    !Number.isFinite(catalog.maxId) ||
    !Array.isArray(catalog.holes)
  ) {
    return undefined;
  }
  const holes = catalog.holes.filter(
    (range): range is [number, number] =>
      Array.isArray(range) &&
      range.length === 2 &&
      typeof range[0] === "number" &&
      typeof range[1] === "number"
  );
  return { maxId: catalog.maxId, holes };
}

async function fetchViewerCatalog(): Promise<ViewerCatalog | undefined> {
  const response = await fetch(`${getViewerOrigin()}/api/catalog`, {
    signal: AbortSignal.timeout(VIEWER_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    return undefined;
  }
  return parseCatalog(await response.json());
}

function refreshCatalog(): Promise<void> {
  if (catalogInFlight !== undefined) {
    return catalogInFlight;
  }
  catalogInFlight = fetchViewerCatalog()
    .then((catalog) => {
      catalogState =
        catalog === undefined
          ? { status: "failed", expiresAt: Date.now() + VIEWER_CATALOG_RETRY_MS }
          : {
              status: "ok",
              catalog,
              expiresAt: Date.now() + VIEWER_CATALOG_REFRESH_MS
            };
    })
    .catch(() => {
      catalogState = {
        status: "failed",
        expiresAt: Date.now() + VIEWER_CATALOG_RETRY_MS
      };
    })
    .finally(() => {
      catalogInFlight = undefined;
    });
  return catalogInFlight;
}

async function resolveCatalogState(): Promise<CatalogState> {
  const current = catalogState;
  if (current.status === "pending") {
    // First request after a cold start: wait a little for a real answer, then
    // answer `pending` and let the fetch finish on its own.
    await Promise.race([
      refreshCatalog(),
      new Promise((resolve) => setTimeout(resolve, VIEWER_CATALOG_COLD_WAIT_MS))
    ]);
    return catalogState;
  }
  if (current.expiresAt <= Date.now()) {
    // Stale-while-revalidate: keep serving the last verdict, refresh in the
    // background.
    void refreshCatalog();
  }
  return current;
}

async function peekRateLimit(
  hostname: string
): Promise<Omit<Extract<RateLimitState, { status: "blocked" }>, "status"> | "ok"> {
  let response: Response;
  try {
    response = await fetch(`${getViewerOrigin()}/api/rate-limit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: hostname }),
      signal: AbortSignal.timeout(VIEWER_FETCH_TIMEOUT_MS)
    });
  } catch {
    return { reason: "rate-limit-check-failed", retryAt: Date.now() + VIEWER_RATE_LIMIT_RETRY_MS };
  }
  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get("Retry-After"));
    const wait = Math.max(
      Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : VIEWER_RATE_LIMIT_RETRY_MS,
      VIEWER_RATE_LIMIT_MIN_WAIT_MS
    );
    return { reason: "rate-limit-check-throttled", retryAt: Date.now() + wait };
  }
  if (!response.ok) {
    return { reason: "rate-limit-check-failed", retryAt: Date.now() + VIEWER_RATE_LIMIT_RETRY_MS };
  }
  let body: RateLimitResponse;
  try {
    body = (await response.json()) as RateLimitResponse;
  } catch {
    return { reason: "rate-limit-check-failed", retryAt: Date.now() + VIEWER_RATE_LIMIT_RETRY_MS };
  }
  const { limit, remaining, resetAt } = body;
  if (limit !== null && remaining !== null && remaining <= limit * VIEWER_MIN_REMAINING_RATIO) {
    const wait = Math.max(
      resetAt !== null ? resetAt - Date.now() : VIEWER_RATE_LIMIT_REFRESH_MS,
      VIEWER_RATE_LIMIT_MIN_WAIT_MS
    );
    return { reason: "rate-limit-exhausted", retryAt: Date.now() + wait };
  }
  return "ok";
}

/** Re-probes the public per-origin quota. Callers pass the gate checks first. */
async function refreshRateLimit(hostname: string): Promise<void> {
  const verdict = await peekRateLimit(hostname);
  rateLimitState =
    verdict === "ok"
      ? { status: "ok", expiresAt: Date.now() + VIEWER_RATE_LIMIT_REFRESH_MS }
      : { status: "blocked", ...verdict };
}

async function resolveRateLimitState(): Promise<RateLimitState> {
  let hostname: string;
  let key: string;
  try {
    hostname = new URL(await steamCallbackUrl.get()).hostname;
    key = await viewerKey.get();
  } catch {
    return {
      status: "blocked",
      reason: "rate-limit-check-failed",
      retryAt: Date.now() + VIEWER_RATE_LIMIT_RETRY_MS
    };
  }
  if (key.trim() !== "" || isTrustedHostname(hostname)) {
    return {
      status: "ok",
      expiresAt: Date.now() + VIEWER_RATE_LIMIT_REFRESH_MS
    };
  }
  const current = rateLimitState;
  if (current.status === "pending") {
    // First request after a cold start: the quota check is a single POST, cheap
    // enough to await so the first visitor gets a real answer.
    rateLimitInFlight ??= refreshRateLimit(hostname).finally(() => {
      rateLimitInFlight = undefined;
    });
    await rateLimitInFlight;
    return rateLimitState;
  }
  const expired =
    current.status === "ok"
      ? current.expiresAt <= Date.now()
      : current.retryAt <= Date.now();
  if (expired) {
    rateLimitInFlight ??= refreshRateLimit(hostname).finally(() => {
      rateLimitInFlight = undefined;
    });
    void rateLimitInFlight;
    // A blocked state stops blocking once its retryAt has passed.
    if (current.status === "blocked") {
      return { status: "pending" };
    }
  }
  return current;
}

export interface ViewerRuntime {
  /** The server's verdict, published as `rules.viewer`. */
  status: ViewerServerStatus;
  /**
   * Whether this deployment may use the viewer at all — the quota / partner key
   * / trusted hostname gate, independent of whether the catalog is readable.
   * Published as `rules.viewerOriginAllowed`.
   */
  originAllowed: boolean;
  /** The catalog from the last good probe, when the viewer is enabled. */
  catalog: ViewerCatalog | undefined;
}

/**
 * Decides, per request, whether the client may use the 3D viewer. Both probes
 * fail closed, so a client is only handed 3D once both have a good answer.
 * The three published fields are derived here so each probe runs at most once
 * per request.
 */
export async function resolveViewerRuntime({
  enabled
}: {
  enabled: boolean;
}): Promise<ViewerRuntime> {
  if (!enabled) {
    return {
      status: { available: false, reason: "disabled" },
      originAllowed: false,
      catalog: undefined
    };
  }
  const [catalog, rateLimit] = await Promise.all([
    resolveCatalogState(),
    resolveRateLimitState()
  ]);
  const originAllowed = rateLimit.status === "ok";
  const status = ((): ViewerServerStatus => {
    if (catalog.status === "pending" || rateLimit.status === "pending") {
      return { available: false, reason: "pending" };
    }
    if (catalog.status === "failed") {
      return { available: false, reason: "catalog-failed" };
    }
    if (rateLimit.status !== "ok") {
      return {
        available: false,
        reason: rateLimit.reason,
        retryAt: rateLimit.retryAt
      };
    }
    return { available: true, catalog: catalog.catalog };
  })();
  return {
    status,
    originAllowed,
    catalog: catalog.status === "ok" ? catalog.catalog : undefined
  };
}

/**
 * Warms both probes. Callable from a scheduled handler (or a request) so the
 * first visitor after a cold start does not pay for the round trip.
 */
export async function warmViewerCaches() {
  try {
    if (!(await viewerEnabled.get())) {
      return;
    }
    await Promise.all([resolveCatalogState(), resolveRateLimitState()]);
  } catch {}
}
