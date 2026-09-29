const E = "f2ebf99b-014f-4139-9321-b8b21d7dae8e";
const base = "http://localhost:8787";
const steamId = "76561198000000000";

async function main() {
  const auth = await fetch(
    `${base}/api/auth/electron?steamId=${steamId}&nickname=Tester&secret=${E}`
  );
  const { sessionCookie } = await auth.json();
  const cookie = sessionCookie.split(";")[0];

  const init = await fetch(`${base}/api/init`, {
    headers: { Cookie: cookie }
  });
  const initJson = await init.json();
  let syncedAt = initJson.user?.syncedAt;
  console.log("fresh syncedAt:", syncedAt);

  async function post(name, body) {
    const res = await fetch(`${base}/api/action/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    console.log(`\n=== ${name} ===\n${res.status}\n${text}`);
    const json = text ? JSON.parse(text) : null;
    if (json?.syncedAt !== undefined) syncedAt = json.syncedAt;
    return { status: res.status, json };
  }

  await post("sync empty actions", { actions: [], syncedAt });

  const add = await post("sync Add AK id=37", {
    actions: [{ type: "add", item: { id: 37 } }],
    syncedAt
  });
  console.log("Add status:", add.status);

  const after = await (await fetch(`${base}/api/init`, { headers: { Cookie: cookie } })).json();
  console.log("\ninventory after Add:", after.user.inventory);

  // Equip + one more sync action in the same batch.
  const add2 = await post("sync Add M4A4 id=38 + add AWP id=40", {
    actions: [
      { type: "add", item: { id: 38, equipped: true } },
      { type: "add", item: { id: 40 } }
    ],
    syncedAt
  });
  console.log("batch Add status:", add2.status);

  const after2 = await (await fetch(`${base}/api/init`, { headers: { Cookie: cookie } })).json();
  const inv = after2.user.inventory ? JSON.parse(after2.user.inventory) : null;
  console.log("\ninventory after batch:", JSON.stringify(inv));
  console.log("items count:", inv ? Object.keys(inv.items).length : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});