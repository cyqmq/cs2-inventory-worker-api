-- CS2 Inventory Simulator — D1 (SQLite) migration 0003.
-- Session revocation and expiry.
--
-- The session cookie is a self-contained HMAC-signed blob, which means the
-- server cannot invalidate one: a cookie captured from a log, a shared machine
-- or a stolen backup stays valid for ~68 years (Max-Age=2147483647). Signing
-- out only tells the browser to drop its copy.
--
-- This table makes a session a row instead:
--   - "revokedAt" NULL means live. Sign-out stamps it, and the cookie stops
--     being accepted on the next request rather than whenever the browser
--     decides to honour the deletion.
--   - "expiresAt" bounds the lifetime on the server side, so the cookie's own
--     Max-Age is not the only thing enforcing it. A cookie with an absurd
--     Max-Age but an old "expiresAt" is rejected.
--
-- "sid" is a random id generated per session and stored inside the cookie
-- payload, so multiple devices can be signed out independently.

CREATE TABLE "Session" (
  "sid" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "revokedAt" INTEGER,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX "Session_userId_idx" ON "Session" ("userId");
-- Expiry and revocation are both point lookups by sid; this index only exists so
-- periodic sweeps of expired rows do not degrade into full scans.
CREATE INDEX "Session_expiresAt_idx" ON "Session" ("expiresAt");
