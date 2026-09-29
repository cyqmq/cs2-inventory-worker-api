/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — CSFloat item info fetch
 *  Port of api/csfloat.server.ts.
 *--------------------------------------------------------------------------------------------*/

import { assert } from "@ianlucas/cs2-lib";
import type { CSFloatItemInfo } from "@ianlucas/cs2-lib-inspect";
import { csFloatUrl, csFloatHeaders } from "../models/rule";
import { badGateway, internalServerError, serviceUnavailable } from "./responses";

export async function fetchCSFloatItemInfo(inspectLink: string) {
  const url = await csFloatUrl.get();
  if (url === "") {
    throw serviceUnavailable;
  }
  const headerPairs = await csFloatHeaders.get();
  if (headerPairs.length % 2 !== 0) {
    throw internalServerError;
  }
  const headers: Record<string, string> = {};
  for (let i = 0; i < headerPairs.length; i += 2) {
    headers[headerPairs[i]] = headerPairs[i + 1];
  }
  const parsedUrl = new URL(url);
  const existingParams = [...parsedUrl.searchParams.keys()];
  if (existingParams.length > 0) {
    const lastKey = existingParams[existingParams.length - 1];
    const lastValue = parsedUrl.searchParams.get(lastKey);
    parsedUrl.searchParams.set(
      lastKey,
      `${lastValue}?url=${encodeURIComponent(inspectLink)}`
    );
  } else {
    parsedUrl.searchParams.set("url", inspectLink);
  }
  try {
    const signal = AbortSignal.timeout(60_000);
    const response = await fetch(parsedUrl.toString(), { headers, signal });
    assert(response.ok);
    return ((await response.json()) as { iteminfo: CSFloatItemInfo }).iteminfo;
  } catch {
    throw badGateway;
  }
}