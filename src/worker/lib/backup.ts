/**
 * Database backup / restore.
 *
 * The shelf's single point of failure is D1: R2 holds the durable content
 * (bundles + baked pages), but D1 holds the works rows — including each
 * work's `secret_hash`, which is the ONLY proof of ownership. Lose D1 and
 * every author's manage key is gone with no recovery (no accounts). So the
 * daily cron dumps D1 to R2 (a different, 11-nines store), and the operator
 * can download a dump on demand for an off-Cloudflare copy.
 *
 * Restore is deliberately NON-DESTRUCTIVE: INSERT OR IGNORE only adds rows
 * that are missing, never overwrites or deletes. A restore can only ever heal
 * a partial loss; it cannot clobber live data. (Reconstructing R2 objects is
 * out of scope — R2 is durable; the realistic failure is D1 loss with R2
 * intact, and this reconnects the metadata to the surviving bundles.)
 */

import type { Env } from './env';

export const BACKUP_VERSION = 1;
export const BACKUP_PREFIX = 'backups/';
/** Keep a month of daily dumps; older ones are pruned by the cron. */
export const BACKUP_RETENTION_DAYS = 30;
/** Safety cap per table so a runaway dump can't exhaust the Worker. */
const MAX_ROWS_PER_TABLE = 200_000;

/** Column allowlists — restore only ever touches these, never posted keys. */
const WORKS_COLUMNS = [
  'id', 'secret_hash', 'title', 'pen_name', 'language', 'rating', 'warnings',
  'word_count', 'first_line', 'status', 'listed', 'password_hash', 'views',
  'letters_open', 'report_count', 'created_at', 'updated_at', 'expires_at',
  'removed_at', 'moderation_verdict', 'moderation_at', 'content_hash',
  'listing_state', 'listed_at', 'listing_verdict', 'verdict_fingerprint', 'cover_mime',
] as const;
const REPORTS_COLUMNS = ['id', 'work_id', 'reason', 'message', 'created_at'] as const;
const LETTERS_COLUMNS = ['id', 'work_id', 'body', 'contact', 'created_at'] as const;
const TOMBSTONES_COLUMNS = ['content_hash', 'work_title', 'created_at', 'note'] as const;
const SETTINGS_COLUMNS = ['key', 'value'] as const;

export interface DatabaseDump {
  version: number;
  exported_at: string;
  works: Record<string, unknown>[];
  reports: Record<string, unknown>[];
  letters: Record<string, unknown>[];
  tombstones: Record<string, unknown>[];
  settings: Record<string, unknown>[];
}

async function dumpTable(db: D1Database, table: string): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(`SELECT * FROM ${table} LIMIT ${MAX_ROWS_PER_TABLE}`)
    .all<Record<string, unknown>>();
  return results;
}

/** Read every row of every table into a portable JSON object. */
export async function dumpDatabase(db: D1Database, nowIso: string): Promise<DatabaseDump> {
  return {
    version: BACKUP_VERSION,
    exported_at: nowIso,
    works: await dumpTable(db, 'works'),
    reports: await dumpTable(db, 'reports'),
    letters: await dumpTable(db, 'letters'),
    tombstones: await dumpTable(db, 'tombstones'),
    settings: await dumpTable(db, 'settings'),
  };
}

function isRowArray(x: unknown): x is Record<string, unknown>[] {
  return Array.isArray(x) && x.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r));
}

async function restoreTable(
  db: D1Database,
  table: string,
  columns: readonly string[],
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const placeholders = columns.map((_, i) => `?${i + 1}`).join(', ');
  const sql = `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  const stmt = db.prepare(sql);
  const batch = rows.map((row) =>
    stmt.bind(...columns.map((c) => (row[c] === undefined ? null : row[c]))),
  );
  await db.batch(batch);
  return rows.length;
}

/**
 * Non-destructive restore: INSERT OR IGNORE for every row, so only missing
 * rows are added — existing rows are never touched, nothing is deleted.
 * Returns a per-table count of rows attempted. Throws on a malformed dump.
 */
export async function restoreDatabase(
  db: D1Database,
  dump: unknown,
): Promise<Record<string, number>> {
  if (typeof dump !== 'object' || dump === null || Array.isArray(dump)) {
    throw new Error('dump is not an object');
  }
  const d = dump as Record<string, unknown>;
  if (d['version'] !== BACKUP_VERSION) throw new Error('unsupported dump version');

  const tables: Array<[string, readonly string[], unknown]> = [
    ['works', WORKS_COLUMNS, d['works']],
    ['reports', REPORTS_COLUMNS, d['reports']],
    ['letters', LETTERS_COLUMNS, d['letters']],
    ['tombstones', TOMBSTONES_COLUMNS, d['tombstones']],
    ['settings', SETTINGS_COLUMNS, d['settings']],
  ];
  const counts: Record<string, number> = {};
  for (const [table, columns, rows] of tables) {
    if (rows === undefined) continue;
    if (!isRowArray(rows)) throw new Error(`${table} is not a row array`);
    if (rows.length > MAX_ROWS_PER_TABLE) throw new Error(`${table} exceeds the row cap`);
    counts[table] = await restoreTable(db, table, columns, rows);
  }
  return counts;
}

export function backupKey(dateIso: string): string {
  // `backups/2026-07-06.json` — one dump per UTC day, overwritten if re-run.
  return `${BACKUP_PREFIX}${dateIso.slice(0, 10)}.json`;
}

/** Dump D1 to R2 and prune dumps older than the retention window. */
export async function runBackup(env: Env, now: number): Promise<void> {
  const nowIso = new Date(now).toISOString();
  const dump = await dumpDatabase(env.SHELF_DB, nowIso);
  await env.SHELF_R2.put(backupKey(nowIso), JSON.stringify(dump), {
    httpMetadata: { contentType: 'application/json' },
  });

  // Prune: list backups/, delete any whose date is older than the window.
  const cutoff = new Date(now - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  let cursor: string | undefined;
  const stale: string[] = [];
  for (;;) {
    const page = await env.SHELF_R2.list({ prefix: BACKUP_PREFIX, cursor });
    for (const obj of page.objects) {
      const date = obj.key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
      if (date < cutoff) stale.push(obj.key);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  for (let i = 0; i < stale.length; i += 1000) {
    await env.SHELF_R2.delete(stale.slice(i, i + 1000));
  }
}
