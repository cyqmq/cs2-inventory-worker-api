/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — Kysely instance
 *
 *  One query codebase, two storage backends:
 *    - D1 (SQLite, free) via kysely-d1
 *    - Hyperdrive + PostgreSQL (paid) via kysely-postgres-js
 *  The instance is created lazily on first use and cached; the active backend
 *  is decided from the request bindings (DB first, HYPERDRIVE fallback).
 *--------------------------------------------------------------------------------------------*/

import { D1Dialect } from "kysely-d1";
import { PostgresJSDialect } from "kysely-postgres-js";
import { Kysely } from "kysely";
import postgres from "postgres";
import { getRuntime } from "../env";
import type { Database } from "./types";

let cached: Kysely<Database> | undefined;

export function db(): Kysely<Database> {
  if (cached !== undefined) {
    return cached;
  }
  const { env } = getRuntime();
  if (env.DB !== undefined) {
    cached = new Kysely<Database>({
      dialect: new D1Dialect({ database: env.DB })
    });
  } else if (env.HYPERDRIVE !== undefined) {
    const pg = postgres(env.HYPERDRIVE.connectionString, {
      prepare: false,
      max: 5,
      fetch_types: false
    });
    cached = new Kysely<Database>({
      dialect: new PostgresJSDialect({ postgres: pg })
    });
  } else {
    throw new Error(
      "No database binding configured. Add a D1 binding named DB or a Hyperdrive binding named HYPERDRIVE to wrangler.jsonc."
    );
  }
  return cached;
}