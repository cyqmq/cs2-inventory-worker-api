/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — shared response helpers
 *--------------------------------------------------------------------------------------------*/

export const noContent = new Response(null, { status: 204 });
export const badRequest = new Response(null, { status: 400 });
export const unauthorizedResponse = new Response(null, { status: 401 });
export const notFoundResponse = new Response(null, { status: 404 });
export const methodNotAllowed = new Response(null, { status: 405 });
export const conflict = new Response(null, { status: 409 });
export const tooManyRequests = new Response(null, { status: 429 });
export const internalServerError = new Response(null, { status: 500 });
export const badGateway = new Response(null, { status: 502 });
export const serviceUnavailable = new Response(null, { status: 503 });

export function res(body: BodyInit | null | undefined, mimeType: string) {
  return new Response(body, {
    headers: { "Content-Type": mimeType }
  });
}

/** JSON 401 used by requireUser (the original redirected to /sign-in). */
export function unauthorized(message = "Unauthorized") {
  return Response.json({ error: message }, { status: 401 });
}