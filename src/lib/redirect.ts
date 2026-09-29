/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — redirect helpers
 *
 *  React-router's `redirect()` produced 302 responses with a Location header and
 *  worked with relative URLs. On Workers we build the Response by hand. When
 *  FRONTEND_URL is configured the browser is sent there (a separate origin that
 *  calls back into this API with cookies); otherwise a relative path on the same
 *  origin is used.
 *--------------------------------------------------------------------------------------------*/

import { getRuntime } from "../env";

export function frontendUrl(): string | undefined {
  const value = getRuntime().env.FRONTEND_URL;
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Location = FRONTEND_URL when set, otherwise the given relative path. */
export function frontendRedirect(
  path: string,
  status: number,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(null, {
    status,
    headers: {
      Location: frontendUrl() ?? path,
      ...(extraHeaders ?? {})
    }
  });
}