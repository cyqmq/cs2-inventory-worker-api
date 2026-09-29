/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — print idempotent seed SQL for the built-in rules
 *
 *  Usage:
 *    D1 local:  npm run db:seed:rules:d1:local
 *    D1 remote: npm run db:seed:rules:d1:remote
 *    PG:        npm run db:seed:rules > seed.sql && psql $DATABASE_URL -f seed.sql
 *               (or: DATABASE_URL=... npx tsx scripts/apply-migrations-pg.ts && DATABASE_URL=...
 *                npx tsx scripts/seed-pg.ts)
 *
 *  Default mode prints INSERT ... ON CONFLICT ("name") DO UPDATE statements for
 *  every rule declared in src/models/rule.ts to stdout. Pass `--d1-local` /
 *  `--d1-remote` to hand the SQL to `wrangler d1 execute` directly instead
 *  (wrangler reads the file over stdin on some platforms/GitBash setups, so the
 *  script writes a tempfile itself for reliability).
 *
 *  Rules that resolve from environment bindings (steamApiKey, steamCallbackUrl,
 *  viewerKey) are skipped on purpose: a Rule row would shadow the env value, and
 *  the original server only stored them in env.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rule } from "../src/models/rule";

/** Quote a SQL string literal (single quotes doubled). */
function sqlQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Serialize a rule default exactly like Rule#set() does for the `value` column. */
function serializeDefaultValue(rule: Rule<string, unknown>): string {
  const type = rule.describeType();
  const value = rule.defaultValue as unknown;
  switch (type) {
    case "string":
    case "number":
    case "boolean":
      return String(value);
    case "string-array":
      return (value as string[]).join(";");
    case "number-array":
      return (value as number[]).join(";");
    default:
      throw new Error(`Unsupported rule type "${type}" for rule "${rule.name}"`);
  }
}

const skipped = Rule.instances.filter((rule) => rule.hasEnvFallback());
const seeded = Rule.instances
  .filter((rule) => !rule.hasEnvFallback())
  .sort((a, b) => a.name.localeCompare(b.name));

if (skipped.length > 0) {
  console.error(
    `Skipping ${skipped.length} env-backed rule(s): ${skipped
      .map((rule) => rule.name)
      .join(", ")}`
  );
}

console.log(
  "-- CS2 Inventory Simulator — seed rules (name, type, value). Idempotent."
);
const statements: string[] = [];
for (const rule of seeded) {
  const type = rule.describeType();
  const value = serializeDefaultValue(rule);
  statements.push(
    `INSERT INTO "Rule" ("name", "type", "value") VALUES ` +
      `(${sqlQuote(rule.name)}, ${sqlQuote(type)}, ${sqlQuote(value)}) ` +
      `ON CONFLICT ("name") DO UPDATE SET "type" = EXCLUDED."type", "value" = EXCLUDED."value";`
  );
}

const target = process.argv[2];
if (target === "--d1-local" || target === "--d1-remote") {
  const remote = target === "--d1-remote" ? "--remote" : "--local";
  const tempFile = join(tmpdir(), `seed-rules-${process.pid}.sql`);
  writeFileSync(tempFile, statements.join("\n") + "\n", "utf8");
  try {
    execSync(
      `npx wrangler d1 execute cs2-inventory-db ${remote} --file "${tempFile}"`,
      { stdio: "inherit" }
    );
  } finally {
    rmSync(tempFile, { force: true });
  }
} else {
  console.log(statements.join("\n"));
}