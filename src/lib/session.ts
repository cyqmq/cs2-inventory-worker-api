/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — session cookie (replaces react-router
 *  createCookieSessionStorage).
 *
 *  Format: `_session=<b64url(JSON payload)>.<b64url(HMAC-SHA256)>`
 *    - payload is a JSON object of key -> string|null session values
 *    - HMAC keyed by SESSION_SECRET (Web Crypto), appended after a dot
 *  Any parsing/signature failure yields an empty session (the original threw a
 *  redirect; API-first workers return 401 via requireUser instead).
 *
 *  Cookie attributes: Path=/; HttpOnly; SameSite=Lax (or SESSION_COOKIE_SAMESITE);
 *  Max-Age=2147483647; Secure enabled unless SESSION_SECURE_COOKIE === "false".
 *--------------------------------------------------------------------------------------------*/

import { getRuntime } from "../env";

export interface WorkerSession {
  data: Record<string, string | null>;
  get(key: string): string | null | undefined;
  set(key: string, value: string | null): void;
  unset(key: string): void;
  has(key: string): boolean;
}

const SESSION_COOKIE_NAME = "_session";
const MAX_AGE = 2147483647;

function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(value: string): Uint8Array | undefined {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function createView(data: Record<string, string | null>): WorkerSession {
  return {
    data,
    get(key) {
      return data[key];
    },
    set(key, value) {
      data[key] = value;
    },
    unset(key) {
      delete data[key];
    },
    has(key) {
      return Object.prototype.hasOwnProperty.call(data, key);
    }
  };
}

type KeyUsageLiteral =
  | "encrypt"
  | "decrypt"
  | "sign"
  | "verify"
  | "deriveKey"
  | "deriveBits"
  | "wrapKey"
  | "unwrapKey";

async function importHmacKey(secret: string, usages: KeyUsageLiteral[]) {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

export async function getSession(cookieHeader: string | undefined | null) {
  const empty = createView({});
  if (!cookieHeader) {
    return empty;
  }
  const entry = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!entry) {
    return empty;
  }
  const raw = entry.slice(SESSION_COOKIE_NAME.length + 1);
  const dot = raw.indexOf(".");
  if (dot === -1) {
    return empty;
  }
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const payloadBytes = b64UrlToBytes(payload);
  const signatureBytes = b64UrlToBytes(signature);
  if (payloadBytes === undefined || signatureBytes === undefined) {
    return empty;
  }
  const { env } = getRuntime();
  const key = await importHmacKey(env.SESSION_SECRET, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, payloadBytes);
  if (!valid) {
    return empty;
  }
  try {
    const decoded = new TextDecoder().decode(payloadBytes);
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return empty;
    }
    return createView(parsed as Record<string, string | null>);
  } catch {
    return empty;
  }
}

export async function commitSession(session: WorkerSession) {
  const { env } = getRuntime();
  const payload = new TextEncoder().encode(JSON.stringify(session.data));
  const key = await importHmacKey(env.SESSION_SECRET, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  const value = `${bytesToB64Url(payload)}.${bytesToB64Url(new Uint8Array(signature))}`;
  const secure =
    (env.SESSION_SECURE_COOKIE ?? "").toLowerCase() !== "false";
  const sameSite = env.SESSION_COOKIE_SAMESITE ?? "Lax";
  const attributes = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${MAX_AGE}`
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export async function destroySession(_session?: WorkerSession) {
  const secure =
    (getRuntime().env.SESSION_SECURE_COOKIE ?? "").toLowerCase() !== "false";
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Max-Age=0"
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export function assignToSession(
  session: WorkerSession,
  keyValues: Record<string, string | undefined | null>
) {
  for (const [key, value] of Object.entries(keyValues)) {
    if (value === undefined) {
      session.unset(key);
    } else {
      session.set(key, value);
    }
  }
}