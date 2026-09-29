const E = "f2ebf99b-014f-4139-9321-b8b21d7dae8e";
const base = "http://localhost:8787";
const steamId = "76561198000000000";

async function main() {
  const auth = await fetch(
    `${base}/api/auth/electron?steamId=${steamId}&nickname=Tester&secret=${E}`
  );
  const { sessionCookie } = await auth.json();
  const cookie = sessionCookie.split(";")[0];

  const init = await (await fetch(`${base}/api/init`, { headers: { Cookie: cookie } })).json();
  let syncedAt = init.user.syncedAt;

  async function req(name, method, path, opts = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      ...opts,
      headers: { Cookie: cookie, ...(opts.headers || {}) }
    });
    const text = await res.text();
    console.log(`\n=== ${name} ===\n${res.status}${res.headers.get("location") ? " -> " + res.headers.get("location") : ""}\n${text.slice(0, 500)}`);
    if (text) {
      try {
        const json = JSON.parse(text);
        if (json.syncedAt !== undefined) syncedAt = json.syncedAt;
        return json;
      } catch {}
    }
    return null;
  }

  // GET endpoints (resync returns JSON; reset-inventory redirects 302 -> /).
  await req("GET resync", "GET", "/api/action/resync");
  await req("GET reset-inventory", "GET", "/api/action/reset-inventory");

  const form = new FormData();
  form.set("language", "schinese");
  form.set("statsForNerds", "true");
  form.set("hideFreeItems", "false");
  form.set("hideFilters", "false");
  form.set("hideNewItemLabel", "false");
  form.set("prefer2dStickerEditor", "false");
  form.set("background", "ancient");
  const res = await fetch(`${base}/api/action/preferences`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
    redirect: "manual"
  });
  const setCookie = res.headers.get("set-cookie") || "";
  console.log(`\n=== POST preferences (formData) ===\n${res.status}${res.headers.get("location") ? " -> " + res.headers.get("location") : ""}\ncookie set: ${setCookie.slice(0, 60)}...`);
  const prefsAfter = await (await fetch(`${base}/api/init`, { headers: { Cookie: cookie + "; " + setCookie.split(";")[0] } })).json();
  console.log("preferences.language after:", prefsAfter.preferences.language);

  // Add a container (id 9129, needs key 9507) and its key via sync.
  // The reset-inventory request above bumped syncedAt, so re-read it first
  // (as a real client would after a session-external mutation).
  const fresh = await (await fetch(`${base}/api/action/resync`, { headers: { Cookie: cookie } })).json();
  syncedAt = fresh.syncedAt;
  await req("sync Add container 9129 + key 9507", "POST", "/api/action/sync", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actions: [
        { type: "add", item: { id: 9129 } },
        { type: "add", item: { id: 9507 } }
      ],
      syncedAt
    })
  });

  const inv = await (await fetch(`${base}/api/inventory/${steamId}.json`, { headers: { Cookie: cookie } })).json();
  console.log("\ninventory:", JSON.stringify(inv.items));
  const caseUid = Number(Object.keys(inv.items || {})[0]);
  console.log("caseUid:", caseUid, "is container:", Boolean(inv.items && inv.items[caseUid]));

  const unlocked = await req("POST unlock-case", "POST", "/api/action/unlock-case", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseUid, keyUid: caseUid + 1, syncedAt })
  });
  if (unlocked) {
    console.log("unlockedItem keys:", Object.keys(unlocked));
  }

  // Equipped v5 should now render the stored items' base shape.
  await req("GET equipped v5", "GET", `/api/equipped/v5/${steamId}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});