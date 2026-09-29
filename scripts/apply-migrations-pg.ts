/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — apply the PostgreSQL migration
 *
 *  Usage:  DATABASE_URL=postgres://user:pass@host/db npm run db:migrate:pg
 *  Applies migrations-pg/0001_init.sql to the database over the postgres.js
 *  driver (same one the worker uses through Hyperdrive), running the script as
 *  a single multi-statement batch.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import postgres from "postgres";

async function main() {
  const connectionString = process.env.DATABASE_URL ?? process.argv[2];
  if (connectionString === undefined) {
    console.error(
      "Usage: DATABASE_URL=postgres://user:pass@host:5432/db npm run db:migrate:pg"
    );
    process.exit(1);
  }
  const sql = postgres(connectionString, {
    prepare: false,
    fetch_types: false
  });
  const file = fileURLToPath(
    new NodeURL("../migrations-pg/0001_init.sql", import.meta.url)
  );
  const script = readFileSync(file, "utf8");
  try {
    await sql.unsafe(script);
    console.log("Applied migrations-pg/0001_init.sql");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});