/*---------------------------------------------------------------------------------------------
 *  End-to-end smoke for the keychain / sticker-slab / charm-pack sync actions
 *  against `wrangler dev` on :8787 (local D1):
 *    unpack-item -> charm detachment with charges
 *    apply-item-keychain / remove-item-keychain (consumes a charm charge)
 *    add-with-keychain
 *    seal-item-sticker (slab + sticker -> display case)
 *    extract-item-sticker (display case -> sticker)
 *  Run: node scripts/smoke-extra-actions.mjs
 *--------------------------------------------------------------------------------------------*/

const E = "f2ebf99b-014f-4139-9321-b8b21d7dae8e";
const base = "http://localhost:8787";
const steamId = "76561198000000014";
const AK_SKIN_ID = 214;
const CHARM_PACK_ID = 12451;
const KEYCHAIN_ID = 13113;
const STICKER_ID = 1847;
const SLAB_ID = 15200;
const DISPLAY_CASE_ID = 15407;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

let failures = 0;
function expect(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

async function main() {
  const auth = await fetchRetry(
    `${base}/api/auth/electron?steamId=${steamId}&nickname=ExtraTester&secret=${E}`
  );
  const { sessionCookie } = await auth.json();
  const headers = { Cookie: sessionCookie.split(";")[0], "Content-Type": "application/json" };

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
      await resync();
      return sync(actions, true);
    }
    if (json.syncedAt !== undefined) syncedAt = json.syncedAt;
    return { status: res.status, json };
  }

  async function inv(label) {
    const items = (await (await fetchRetry(`${base}/api/inventory/${userId}.json`)).json()).items ?? {};
    console.log(`inventory ${label}: ${JSON.stringify(items)}`);
    return items;
  }

  async function syncOk(actions, label) {
    const { status } = await sync(actions);
    expect(status, 200, label);
    return status;
  }

  function findUid(items, id, predicate = () => true) {
    const uid = Object.keys(items).find(
      (k) => items[k].id === id && predicate(items[k])
    );
    return uid === undefined ? undefined : Number(uid);
  }

  // --- clean slate -----------------------------------------------------------------
  await syncOk([{ type: "remove-all-items" }], "setup: remove-all-items");

  // --- unpack-item: charm pack -> charm detachment with charges --------------------
  await syncOk([{ type: "add", item: { id: CHARM_PACK_ID } }], "setup: add charm pack");
  let items = await inv("with charm pack");
  const packUid = findUid(items, CHARM_PACK_ID);
  expect(packUid !== undefined, true, "charm pack uid found");

  await syncOk([{ type: "unpack-item", uid: packUid }], "unpack-item -> charm detachment");
  items = await inv("after unpack");
  const charmUid = findUid(items, 12450);
  const charmCharges = items[charmUid]?.charges;
  console.log(`     charm detachment uid=${charmUid} charges=${charmCharges}`);
  expect(charmUid !== undefined, true, "charm detachment created");
  expect(typeof charmCharges === "number" && charmCharges >= 3, true, "charm has >= 3 charges");

  // --- apply-item-keychain ----------------------------------------------------------
  await syncOk(
    [
      { type: "add", item: { id: AK_SKIN_ID } },
      { type: "add", item: { id: KEYCHAIN_ID } }
    ],
    "setup: add AK skin + keychain"
  );
  items = await inv("before apply keychain");
  const akUid = findUid(items, AK_SKIN_ID);
  const kcUid = findUid(items, KEYCHAIN_ID);
  expect(akUid !== undefined && kcUid !== undefined, true, "AK + keychain uids found");

  await syncOk(
    [{ type: "apply-item-keychain", targetUid: akUid, keychainUid: kcUid, x: 0, y: 0, z: 0 }],
    "apply-item-keychain -> AK gains keychain"
  );
  items = await inv("after apply keychain");
  expect(items[akUid]?.keychains?.["0"]?.id, KEYCHAIN_ID, "AK keychain slot 0 = keychain id");

  // --- remove-item-keychain (consumes a charm charge, re-adds the keychain) --------
  await syncOk(
    [{ type: "remove-item-keychain", targetUid: akUid, slot: 0 }],
    "remove-item-keychain -> keychain detached"
  );
  items = await inv("after remove keychain");
  expect(items[akUid]?.keychains, undefined, "AK keychain removed");
  const kcReadded = findUid(items, KEYCHAIN_ID);
  const charmChargesAfterRemove = items[charmUid]?.charges;
  console.log(`     keychain re-added uid=${kcReadded}, charm charges=${charmChargesAfterRemove}`);
  expect(kcReadded !== undefined, true, "keychain re-added as separate item");
  expect(
    typeof charmChargesAfterRemove === "number" &&
      charmChargesAfterRemove === charmCharges - 1,
    true,
    "charm charge consumed by detach (charges - 1)"
  );

  // --- add-with-keychain -------------------------------------------------------------
  await syncOk(
    [{ type: "add-with-keychain", itemId: AK_SKIN_ID, keychainUid: kcReadded, x: 0, y: 0, z: 0 }],
    "add-with-keychain -> new AK skin carrying keychain"
  );
  items = await inv("after add-with-keychain");
  const akWithKcUid = findUid(items, AK_SKIN_ID, (item) => item !== undefined && item.keychains !== undefined);
  expect(akWithKcUid !== undefined, true, "new AK skin has keychain attached");
  expect(items[akWithKcUid]?.keychains?.["0"]?.id, KEYCHAIN_ID, "attached keychain id matches");

  // --- seal-item-sticker: slab + sticker -> display case -----------------------------
  await syncOk(
    [
      { type: "add", item: { id: SLAB_ID } },
      { type: "add", item: { id: STICKER_ID } }
    ],
    "setup: add sticker slab + sticker"
  );
  items = await inv("before seal");
  const slabUid = findUid(items, SLAB_ID);
  const stickerUid = findUid(items, STICKER_ID);
  expect(slabUid !== undefined && stickerUid !== undefined, true, "slab + sticker uids found");

  await syncOk(
    [{ type: "seal-item-sticker", toolUid: slabUid, stickerUid }],
    "seal-item-sticker -> display case"
  );
  items = await inv("after seal");
  expect(
    findUid(items, SLAB_ID) === undefined && findUid(items, STICKER_ID) === undefined,
    true,
    "slab + sticker consumed"
  );
  const caseUid = findUid(items, DISPLAY_CASE_ID);
  expect(caseUid !== undefined, true, "display case created");

  // --- extract-item-sticker: display case -> sticker ---------------------------------
  await syncOk([{ type: "extract-item-sticker", uid: caseUid }], "extract-item-sticker -> sticker back");
  items = await inv("after extract");
  expect(findUid(items, DISPLAY_CASE_ID) === undefined, true, "display case consumed");
  expect(findUid(items, STICKER_ID) !== undefined, true, "sticker restored");

  console.log(
    failures === 0
      ? "\nEXTRA ACTIONS SMOKE: all assertions passed"
      : `\nEXTRA ACTIONS SMOKE: ${failures} failure(s)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
