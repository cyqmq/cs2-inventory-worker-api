/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — GET /healthz
 *--------------------------------------------------------------------------------------------*/

import type { Context } from "hono";
import { methodNotAllowed } from "../lib/responses";

export async function healthz(c: Context) {
  const request = c.req.raw;
  if (request.method !== "GET") {
    throw methodNotAllowed;
  }
  return new Response("Supposedly healthy", {
    status: 200,
    headers: { "Cache-Control": "no-store" }
  });
}