/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — per-request API call log
 *
 *  Append-only record of every request handled by the Worker, used by the
 *  admin dashboard (`/api/admin/stats`) to report usage. Writes are best-effort:
 *  a logging failure must never break the request it is recording.
 *--------------------------------------------------------------------------------------------*/

import { db } from "../db/database";

export async function insertRequestLog(entry: {
  method: string;
  path: string;
  status: number;
  userId?: string;
  createdAt?: number;
}) {
  try {
    await db()
      .insertInto("RequestLog")
      .values({
        method: entry.method,
        path: entry.path,
        status: entry.status,
        userId: entry.userId ?? null,
        createdAt: entry.createdAt ?? Date.now()
      })
      .execute();
  } catch {
    // Ignore: the dashboard is best-effort telemetry.
  }
}