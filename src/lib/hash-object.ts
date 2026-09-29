/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — hash-object 5.1.0 port
 *
 *  Faithful re-implementation of the `hash-object` package (stable SHA-512 over a
 *  normalized + deep-sorted JSON string) using the Web Crypto API, because the
 *  original depends on node:crypto which Cloudflare Workers does not expose.
 *
 *  Pipeline (matches hash-object@5.1.0):
 *    1. normalizeObject — NFD-normalize every string key/value, recurse arrays/objects
 *    2. sortKeys(deep)  — lexical key sort (Array.prototype.sort), recurse arrays/objects
 *    3. JSON.stringify  — canonical serialization
 *    4. SHA-512 hex     — Web Crypto digest
 *
 *  The equipped endpoints truncate the result to the first 7 chars (substring(0,7)).
 *--------------------------------------------------------------------------------------------*/

function isObj(value: unknown): value is Record<string, unknown> {
  const type = typeof value;
  return value !== null && (type === "object" || type === "function");
}

/** Mirrors hash-object/utilities.js normalizeObject. */
function normalizeObject(object: unknown): unknown {
  if (typeof object === "string") {
    return object.normalize("NFD");
  }
  if (Array.isArray(object)) {
    return object.map((element) => normalizeObject(element));
  }
  if (isObj(object)) {
    return Object.fromEntries(
      Object.entries(object).map(([key, value]) => [
        key.normalize("NFD"),
        normalizeObject(value)
      ])
    );
  }
  return object;
}

/** Mirrors sort-keys --deep: Arrays keep order and recurse; objects sort keys. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      Array.isArray(item) || isPlainObject(item) ? sortKeysDeep(item) : item
    );
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      result[key] =
        Array.isArray(item) || isPlainObject(item) ? sortKeysDeep(item) : item;
    }
    return result;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Async SHA-512 hex hash of a plain JSON-like object (see header comment). */
export async function hashObject(
  object: unknown,
  algorithm: "SHA-512" = "SHA-512"
): Promise<string> {
  if (!isObj(object)) {
    throw new TypeError("Expected an object");
  }
  // Acyclic in practice (econ data / serialized inventory); decircular from
  // hash-object@5.1.0 is a no-op for those inputs.
  const normalized = normalizeObject(object);
  const sorted = sortKeysDeep(normalized);
  const json = JSON.stringify(sorted);
  const data = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest(algorithm, data);
  return toHex(new Uint8Array(digest));
}