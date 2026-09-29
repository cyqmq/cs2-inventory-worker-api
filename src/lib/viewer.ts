/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — 3D viewer origin/catalog resolution
 *  Port of app/api/data/viewer.server.ts.
 *--------------------------------------------------------------------------------------------*/

import { getRuntime } from "../env";
import { viewerEnabled, viewerKey, steamCallbackUrl } from "../models/rule";

export const DEFAULT_VIEWER_EMBED_URL = "https://3d.cstrike.app/view";

export interface ViewerCatalog {
  maxId: number;
  holes: [number, number][];
}

const VIEWER_MIN_REMAINING_RATIO = 0.1;
const VIEWER_PEEK_TTL_MS = 60_000;
const VIEWER_PEEK_ERROR_TTL_MS = 30_000;

interface PeekResponse {
  limit: number | null;
  remaining: number | null;
}

interface PeekCacheEntry {
  expiresAt: number;
  verdict: boolean;
}

const peekCache = new Map<string, PeekCacheEntry>();
const peekInFlight = new Set<string>();

function getViewerOrigin() {
  const embedUrl = getRuntime().env.VIEWER_EMBED_URL;
  return new URL(embedUrl || DEFAULT_VIEWER_EMBED_URL).origin;
}

function getCustomTrustedHostnames(): string[] {
  const value = getRuntime().env.TRUSTED_HOSTNAMES;
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

function isTrustedHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return true;
  }
  const custom = getCustomTrustedHostnames();
  if (
    custom.some(
      (h) =>
        hostname === h || hostname.endsWith(h.startsWith(".") ? h : `.${h}`)
    )
  ) {
    return true;
  }
  return false;
}

async function peekOriginAllowed(domain: string) {
  const response = await fetch(`${getViewerOrigin()}/api/rate-limit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain })
  });
  if (!response.ok) {
    return false;
  }
  const { limit, remaining } = (await response.json()) as PeekResponse;
  if (remaining === null || limit === null) {
    return true;
  }
  return remaining > limit * VIEWER_MIN_REMAINING_RATIO;
}

function refreshPeek(domain: string) {
  if (peekInFlight.has(domain)) {
    return;
  }
  peekInFlight.add(domain);
  peekOriginAllowed(domain)
    .then((verdict) => {
      peekCache.set(domain, {
        expiresAt: Date.now() + VIEWER_PEEK_TTL_MS,
        verdict
      });
    })
    .catch(() => {
      peekCache.set(domain, {
        expiresAt: Date.now() + VIEWER_PEEK_ERROR_TTL_MS,
        verdict: false
      });
    })
    .finally(() => {
      peekInFlight.delete(domain);
    });
}

export function resolveViewerOriginAllowed({
  enabled,
  hostname,
  key
}: {
  enabled: boolean;
  hostname: string;
  key: string;
}) {
  if (!enabled) {
    return false;
  }
  if (key.trim() !== "" || isTrustedHostname(hostname)) {
    return true;
  }
  const cached = peekCache.get(hostname);
  if (cached === undefined || cached.expiresAt <= Date.now()) {
    refreshPeek(hostname);
  }
  return cached?.verdict ?? false;
}

const VIEWER_CATALOG_TTL_MS = 300_000;
const VIEWER_CATALOG_ERROR_TTL_MS = 30_000;
const VIEWER_CATALOG_COLD_WAIT_MS = 1500;

interface CatalogCacheEntry {
  expiresAt: number;
  catalog: ViewerCatalog | undefined;
}

let catalogCache: CatalogCacheEntry | undefined;
let catalogInFlight: Promise<void> | undefined;

async function fetchViewerCatalog(): Promise<ViewerCatalog | undefined> {
  const response = await fetch(`${getViewerOrigin()}/api/catalog`);
  if (!response.ok) {
    return undefined;
  }
  const data = (await response.json()) as Partial<ViewerCatalog> | null;
  if (
    typeof data?.maxId !== "number" ||
    !Number.isFinite(data.maxId) ||
    !Array.isArray(data.holes)
  ) {
    return undefined;
  }
  const holes = data.holes.filter(
    (range): range is [number, number] =>
      Array.isArray(range) &&
      range.length === 2 &&
      typeof range[0] === "number" &&
      typeof range[1] === "number"
  );
  return { maxId: data.maxId, holes };
}

function refreshViewerCatalog(): Promise<void> {
  if (catalogInFlight !== undefined) {
    return catalogInFlight;
  }
  catalogInFlight = fetchViewerCatalog()
    .then((catalog) => {
      catalogCache = {
        expiresAt:
          Date.now() +
          (catalog === undefined
            ? VIEWER_CATALOG_ERROR_TTL_MS
            : VIEWER_CATALOG_TTL_MS),
        catalog
      };
    })
    .catch(() => {
      catalogCache = {
        expiresAt: Date.now() + VIEWER_CATALOG_ERROR_TTL_MS,
        catalog: undefined
      };
    })
    .finally(() => {
      catalogInFlight = undefined;
    });
  return catalogInFlight;
}

export async function resolveViewerCatalog(): Promise<
  ViewerCatalog | undefined
> {
  const cached = catalogCache;
  if (cached !== undefined) {
    if (cached.expiresAt <= Date.now()) {
      void refreshViewerCatalog();
    }
    return cached.catalog;
  }
  await Promise.race([
    refreshViewerCatalog(),
    new Promise((resolve) => setTimeout(resolve, VIEWER_CATALOG_COLD_WAIT_MS))
  ]);
  return catalogCache?.catalog;
}

export async function warmViewerCaches() {
  try {
    const enabled = await viewerEnabled.get();
    if (!enabled) {
      return;
    }
    void refreshViewerCatalog();
    resolveViewerOriginAllowed({
      enabled,
      hostname: new URL(await steamCallbackUrl.get()).hostname,
      key: await viewerKey.get()
    });
  } catch {}
}