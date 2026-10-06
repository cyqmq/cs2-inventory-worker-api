/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/init
 *  Port of api.init._index.tsx. Preferences: logged-in users get values from the
 *  UserPreference row (DB takes priority over the cookie); anonymous users fall
 *  back to the session cookie + country-derived language.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { findRequestUser } from "../auth";
import { middleware } from "../middleware";
import { getClientRules } from "../models/rule";
import { getBackground } from "../preferences/background";
import { getToggleable } from "../preferences/toggleable";
import { getSession } from "../lib/session";
import { nonEmptyString } from "../lib/misc";
import { getRuntime } from "../env";
import { resolveSteamCallbackUrl } from "../lib/steam";
import { resolveViewerRuntime } from "../lib/viewer";
import { getUserPreferences } from "../models/user-preference";
import { getLanguage, isValidLanguage } from "../preferences/language";
import { languages, type LanguageName } from "../lib/languages";

function getLangFromLanguage(name: string) {
  return (
    languages.find(({ name: otherName }) => {
      return otherName === name;
    })?.lang ?? "en-US"
  );
}

/** The configured DEFAULT_LANGUAGE when it names a supported language. */
function resolveDefaultLanguage(): string | undefined {
  const value = getRuntime().env.DEFAULT_LANGUAGE?.trim();
  return value !== undefined && isValidLanguage(value) ? value : undefined;
}

/** The configured ENABLED_LANGUAGES subset, or undefined when all are allowed. */
function resolveEnabledLanguages(): string[] | undefined {
  const value = getRuntime().env.ENABLED_LANGUAGES;
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const valid = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(
      (entry): entry is LanguageName =>
        entry.length > 0 && isValidLanguage(entry)
    );
  return valid.length > 0 ? valid : undefined;
}

export async function init(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  const session = await getSession(request.headers.get("Cookie"));
  const user = await findRequestUser(request);
  const ipCountry = request.headers.get("CF-IPCountry");
  const { origin: appUrl, host: appSiteName } = new URL(
    resolveSteamCallbackUrl(request)
  );
  const clientRules = await getClientRules(user?.id);
  const viewer = await resolveViewerRuntime({
    enabled: clientRules.viewerEnabled
  });
  const env = getRuntime().env;

  let preferences;
  if (user !== undefined) {
    const stored = await getUserPreferences(user.id, [
      "background",
      "hideFilters",
      "hideFreeItems",
      "hideNewItemLabel",
      "language",
      "prefer2dStickerEditor",
      "statsForNerds"
    ]);
    const defaultLanguage = resolveDefaultLanguage();
    const language =
      stored.language ??
      defaultLanguage ??
      languages.find(({ countries }) =>
        countries.includes((ipCountry || "us").toLowerCase())
      )?.name ??
      "english";
    preferences = {
      background: stored.background ?? null,
      lang: getLangFromLanguage(language),
      language,
      hideFilters: stored.hideFilters === "true",
      hideFreeItems: stored.hideFreeItems === "true",
      hideNewItemLabel: stored.hideNewItemLabel === "true",
      prefer2dStickerEditor: stored.prefer2dStickerEditor === "true",
      statsForNerds: stored.statsForNerds === "true"
    };
  } else {
    preferences = {
      ...(await getBackground(session)),
      ...(await getLanguage(session, ipCountry, resolveDefaultLanguage())),
      ...(await getToggleable(session))
    };
  }

  return c.json({
    rules: {
      ...clientRules,
      assetsBaseUrl: nonEmptyString(env.ASSETS_BASE_URL),
      viewerEmbedUrl: nonEmptyString(env.VIEWER_EMBED_URL),
      viewerAssetsBaseUrl: nonEmptyString(env.VIEWER_ASSETS_BASE_URL),
      cloudflareAnalyticsToken: nonEmptyString(env.CLOUDFLARE_ANALYTICS_TOKEN),
      sourceCommit: env.SOURCE_COMMIT,
      viewerOriginAllowed: viewer.originAllowed,
      viewerCatalog: clientRules.viewerEnabled ? viewer.catalog : undefined,
      enabledLanguages: resolveEnabledLanguages(),
      // Always sent, like upstream's root loader (which publishes the verdict
      // for disabled deployments too, as `{ available: false, reason: "disabled" }`).
      viewer: viewer.status,
      meta: { appUrl, appSiteName }
    },
    preferences,
    user
  });
}