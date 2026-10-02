/*---------------------------------------------------------------------------------------------
 *  End-to-end smoke for /api/consume-item-spray and /api/increment-item-stattrak
 *  against `wrangler dev` on :8787 (local D1, migration 0002 applied).
 *  Economy ids: AK skin 214 (T-side, non-default), graffiti 9543.
 *  v9 semantics exercised: sealed graffiti must be unsealed before equipping,
 *  team weapons equip with an explicit team, stattrak needs a seeded counter.
 *  Run: node scripts/smoke-spray-stattrak.mjs
 *--------------------------------------------------------------------------------------------*/

const E = "f2ebf99b-014f-4139-9321-b8b21d7dae8e";
const base = "http://localhost:8787";
const steamId = "76561198000000010";
const AK_SKIN_ID = 214;
const GRAFFITI_ID = 9543;

let failures = 0;
function expect(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// workerd under wrangler dev occasionally drops a connection (ECONNABORTED);
// retry connection-level failures a few times before giving up.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      lastErr = err;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

async function main() {
  const auth = await fetchRetry(
    `${base}/api/auth/electron?steamId=${steamId}&nickname=SprayTester&secret=${E}`
  );
  const { sessionCookie } = await auth.json();
  const cookie = sessionCookie.split(";")[0];
  const headers = { Cookie: cookie, "Content-Type": "application/json" };

  const init = await (await fetchRetry(`${base}/api/init`, { headers })).json();
  const userId = init.user.id;
  let syncedAt = init.user.syncedAt;

  async function resync() {
    const json = await (
      await fetchRetry(`${base}/api/action/resync`, { headers })
    ).json();
    syncedAt = json.syncedAt;
    return json;
  }

  async function sync(actions, retried = false) {
    const res = await fetchRetry(`${base}/api/action/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ syncedAt, actions })
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 409 && !retried) {
      // The public endpoints (spray/stattrak) rewrite the user row behind
      // our back and bump syncedAt; re-resync and retry once, like the
      // real client does.
      await resync();
      return sync(actions, true);
    }
    if (json.syncedAt !== undefined) {
      syncedAt = json.syncedAt;
    }
    return { status: res.status, json };
  }

  async function inventory() {
    return (await (await fetchRetry(`${base}/api/inventory/${userId}.json`)).json()).items ?? {};
  }

  const { execSync } = await import("node:child_process");
  const d1 = (sql) =>
    execSync(`npx wrangler d1 execute cs2-inventory-db --local --command "${sql}"`, {
      stdio: "pipe"
    });

  // Clean slate, then add AK skin + sealed graffiti.
  await sync([{ type: "remove-all-items" }]);
  const addRes = await sync([
    { type: "add", item: { id: AK_SKIN_ID } },
    { type: "add", item: { id: GRAFFITI_ID } }
  ]);
  expect(addRes.status, 200, "setup: add AK skin + graffiti");

  let items = await inventory();
  const akUid = Number(Object.keys(items).find((k) => items[k].id === AK_SKIN_ID));
  const graffitiUid = Number(Object.keys(items).find((k) => items[k].id === GRAFFITI_ID));
  if (Number.isNaN(akUid) || Number.isNaN(graffitiUid)) {
    console.error("FAIL setup: could not find added items", items);
    process.exit(1);
  }
  console.log(`setup: ak uid=${akUid}, graffiti uid=${graffitiUid}`);

  // --- public rules off → 401 --------------------------------------------------
  d1(`UPDATE Rule SET value='false' WHERE name IN ('apiPublicStatTrakIncrement','apiPublicSprayConsume');`);

  const pubSpray = await fetchRetry(`${base}/api/consume-item-spray`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, targetUid: graffitiUid })
  });
  expect(pubSpray.status, 401, "spray public with rule off → 401");

  const pubStattrak = await fetchRetry(`${base}/api/increment-item-stattrak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, targetUid: akUid })
  });
  expect(pubStattrak.status, 401, "stattrak public with rule off → 401");

  // invalid apiKey → 401; missing body fields → 400 (zod)
  const badKey = await fetchRetry(`${base}/api/consume-item-spray`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "not-a-real-key", userId, targetUid: graffitiUid })
  });
  expect(badKey.status, 401, "spray with invalid apiKey → 401");

  const zodMiss = await fetchRetry(`${base}/api/increment-item-stattrak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId })
  });
  expect(zodMiss.status, 400, "stattrak missing targetUid → 400 (zod)");

  // --- public rules on, unequipped → 400 ----------------------------------------
  d1(`UPDATE Rule SET value='true' WHERE name IN ('apiPublicStatTrakIncrement','apiPublicSprayConsume');`);

  const sprayUnequipped = await fetchRetry(`${base}/api/consume-item-spray`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, targetUid: graffitiUid })
  });
  expect(sprayUnequipped.status, 400, "spray unequipped → 400 (equipped assert)");

  const stattrakUnequipped = await fetchRetry(`${base}/api/increment-item-stattrak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, targetUid: akUid })
  });
  expect(stattrakUnequipped.status, 400, "stattrak unequipped → 400 (equipped assert)");

  // --- equip: weapon with team=2 (T) ---------------------------------------------
  const equipAk = await sync([{ type: "equip", uid: akUid, team: 2 }]);
  expect(equipAk.status, 200, "equip AK skin with team=2");

  // --- graffiti: sealed → unseal → equip ------------------------------------------
  const equipSealed = await sync([{ type: "equip", uid: graffitiUid }]);
  expect(equipSealed.status, 400, "equip sealed graffiti → 400 (isSealed assert)");

  const unseal = await sync([{ type: "unseal-item", uid: graffitiUid }]);
  expect(unseal.status, 200, "unseal-item → 200");

  const equipGraffiti = await sync([{ type: "equip", uid: graffitiUid }]);
  expect(equipGraffiti.status, 200, "equip unsealed graffiti → 200");

  // --- spray happy path + rate limit -----------------------------------------------
  const itemsBefore = await inventory();
  const chargesBefore = itemsBefore[graffitiUid]?.charges;

  // Bucket rows persist across runs (and the unequipped-400 probes above
  // consumed tokens too), so reset them before the counted assertions.
  d1(`DELETE FROM RateLimitBucket WHERE key LIKE 'spray:%' OR key LIKE 'stattrak:%';`);

  const spray1 = await fetchRetry(`${base}/api/consume-item-spray`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, targetUid: graffitiUid })
  });
  expect(spray1.status, 204, "spray consume #1 (equipped) → 204");

  const itemsAfterSpray = await inventory();
  const chargesAfter = itemsAfterSpray[graffitiUid]?.charges;
  console.log(`     charges before=${JSON.stringify(chargesBefore)} after=${JSON.stringify(chargesAfter)}`);
  expect(
    typeof chargesAfter === "number" && chargesAfter === (chargesBefore ?? 50) - 1,
    true,
    "spray decremented charges by 1"
  );

  // Bucket capacity 1 / 30s refill → immediate second call → 429.
  const spray2 = await fetchRetry(`${base}/api/consume-item-spray`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, targetUid: graffitiUid })
  });
  expect(spray2.status, 429, "spray consume #2 immediately → 429 (token bucket)");

  // --- stattrak: seed counter via edit, then burst to the cap ----------------------
  await sync([{ type: "unequip", uid: akUid, team: 2 }]);
  const seedStatTrak = await sync([
    { type: "edit", uid: akUid, attributes: { statTrak: true } }
  ]);
  expect(seedStatTrak.status, 200, "seed statTrak counter via edit");
  await sync([{ type: "equip", uid: akUid, team: 2 }]);

  // Same as above: deterministic bucket before the counted burst.
  d1(`DELETE FROM RateLimitBucket WHERE key LIKE 'stattrak:%';`);

  let increments = 0;
  let stattrakStatus = 0;
  for (let i = 0; i < 60; i++) {
    const res = await fetchRetry(`${base}/api/increment-item-stattrak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, targetUid: akUid })
    });
    stattrakStatus = res.status;
    if (res.status === 204) {
      increments++;
    } else {
      break;
    }
  }
  expect(stattrakStatus, 429, "stattrak hits 429 when the bucket drains");
  expect(
    increments >= 50 && increments <= 55,
    true,
    `stattrak allowed ~50 (capacity) before 429 (got ${increments})`
  );

  const itemsAfterStattrak = await inventory();
  console.log(`     statTrak counter after burst: ${itemsAfterStattrak[akUid]?.statTrak}`);
  expect(
    (itemsAfterStattrak[akUid]?.statTrak ?? 0) >= 50,
    true,
    "stattrak counter incremented to >= 50"
  );

  // --- cleanup: rules back off ------------------------------------------------------
  d1(`UPDATE Rule SET value='false' WHERE name IN ('apiPublicStatTrakIncrement','apiPublicSprayConsume');`);

  console.log(
    failures === 0
      ? "\nSPRAY/STATTRAK SMOKE: all assertions passed"
      : `\nSPRAY/STATTRAK SMOKE: ${failures} failure(s)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
