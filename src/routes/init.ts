/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /api/init
 *  Port of api.init._index.tsx. Preferences: logged-in users get values from the
 *  UserPreference row (DB takes priority over the cookie); anonymous users fall
 *  back to the session cookie + country-derived language.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { findRequestUser } from "../auth";
import { middleware } from "../middleware";
import { getClientRules, steamCallbackUrl } from "../models/rule";
import { getBackground } from "../preferences/background";
import { getLanguage } from "../preferences/language";
import { getToggleable } from "../preferences/toggleable";
import { getSession } from "../lib/session";
import { nonEmptyString } from "../lib/misc";
import { getRuntime } from "../env";
import { resolveViewerCatalog, resolveViewerOriginAllowed } from "../lib/viewer";
import { getUserPreferences } from "../models/user-preference";
import { languages } from "../lib/languages";

function getLangFromLanguage(name: string) {
  return (
    languages.find(({ name: otherName }) => {
      return otherName === name;
    })?.lang ?? "en-US"
  );
}

export async function init(c: Context) {
  const request = c.req.raw;
  await middleware(request);
  const session = await getSession(request.headers.get("Cookie"));
  const user = await findRequestUser(request);
  const ipCountry = request.headers.get("CF-IPCountry");
  const { origin: appUrl, host: appSiteName } = new URL(
    await steamCallbackUrl.get()
  );
  const clientRules = await getClientRules(user?.id);
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
    const language =
      stored.language ?? languages.find(({ countries }) =>
        countries.includes((ipCountry || "us").toLowerCase())
      )?.name ?? "english";
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
      ...(await getLanguage(session, ipCountry)),
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
      viewerOriginAllowed: resolveViewerOriginAllowed({
        enabled: clientRules.viewerEnabled,
        hostname: new URL(appUrl).hostname,
        key: clientRules.viewerKey
      }),
      viewerCatalog: clientRules.viewerEnabled
        ? await resolveViewerCatalog()
        : undefined,
      meta: { appUrl, appSiteName }
    },
    preferences,
    user
  });
}