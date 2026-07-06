/**
 * D1 access for the works table. Every SQL statement in the app lives here —
 * the route modules never build queries themselves.
 */

export interface WorkRow {
  id: string;
  secret_hash: string;
  title: string;
  pen_name: string;
  language: string;
  rating: string;
  /** JSON-encoded string[] */
  warnings: string;
  word_count: number;
  first_line: string;
  status: string;
  listed: number;
  password_hash: string | null;
  views: number;
  letters_open: number;
  report_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  /** Set by an operator removal; NULL unless status='removed'. */
  removed_at: string | null;
}

export interface NewWork {
  id: string;
  secret_hash: string;
  title: string;
  pen_name: string;
  language: string;
  rating: string;
  warnings: string[];
  word_count: number;
  first_line: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface WorkUpdate {
  title: string;
  rating: string;
  warnings: string[];
  word_count: number;
  first_line: string;
  updated_at: string;
}

export async function getWork(db: D1Database, id: string): Promise<WorkRow | null> {
  return await db.prepare('SELECT * FROM works WHERE id = ?1').bind(id).first<WorkRow>();
}

export async function insertWork(db: D1Database, w: NewWork): Promise<void> {
  await db
    .prepare(
      `INSERT INTO works
        (id, secret_hash, title, pen_name, language, rating, warnings,
         word_count, first_line, created_at, updated_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      w.id,
      w.secret_hash,
      w.title,
      w.pen_name,
      w.language,
      w.rating,
      JSON.stringify(w.warnings),
      w.word_count,
      w.first_line,
      w.created_at,
      w.updated_at,
      w.expires_at,
    )
    .run();
}

export async function updateWork(db: D1Database, id: string, u: WorkUpdate): Promise<void> {
  await db
    .prepare(
      `UPDATE works SET title = ?1, rating = ?2, warnings = ?3,
         word_count = ?4, first_line = ?5, updated_at = ?6
       WHERE id = ?7`,
    )
    .bind(u.title, u.rating, JSON.stringify(u.warnings), u.word_count, u.first_line, u.updated_at, id)
    .run();
}

export async function deleteWork(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM works WHERE id = ?1').bind(id).run();
  // Reports about a gone work carry no weight and no context — evaporate too.
  await db.prepare('DELETE FROM reports WHERE work_id = ?1').bind(id).run();
}

export async function renewWork(db: D1Database, id: string, expiresAt: string): Promise<void> {
  await db.prepare('UPDATE works SET expires_at = ?1 WHERE id = ?2').bind(expiresAt, id).run();
}

export async function incrementViews(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE works SET views = views + 1 WHERE id = ?1').bind(id).run();
}

/**
 * Ids of unlisted works whose expiry has passed (for the daily purge).
 * Removed works are excluded here — their lifetime is the operator grace
 * window (removed_at + 30d, see listRemovedBefore), not expires_at.
 */
export async function listExpired(db: D1Database, nowIso: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM works WHERE expires_at < ?1 AND listed = 0 AND status != 'removed' LIMIT ?2")
    .bind(nowIso, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Ids of removed works whose grace window has passed (removed_at < cutoff). */
export async function listRemovedBefore(db: D1Database, cutoffIso: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM works WHERE status = 'removed' AND removed_at IS NOT NULL AND removed_at < ?1 LIMIT ?2")
    .bind(cutoffIso, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export function bundleKey(id: string): string {
  return `works/${id}/bundle.json`;
}

export function pageKey(id: string): string {
  return `works/${id}/index.html`;
}

/** Chapter page n (1-based, reading order over standard + back matter). */
export function chapterKey(id: string, n: number): string {
  return `works/${id}/ch/${n}.html`;
}

export function chapterPrefix(id: string): string {
  return `works/${id}/ch/`;
}

/** Everything a work owns in R2 lives under this prefix. */
export function workPrefix(id: string): string {
  return `works/${id}/`;
}

// ---------- operator toolkit (Phase 1.5) ----------

export interface AdminWorkSummary {
  id: string;
  title: string;
  pen_name: string;
  rating: string;
  word_count: number;
  views: number;
  report_count: number;
  status: string;
  created_at: string;
  expires_at: string;
}

export interface ReportRow {
  id: string;
  work_id: string;
  reason: string;
  message: string;
  created_at: string;
}

export interface RecentReport extends ReportRow {
  /** NULL when the reported work has since been purged. */
  work_title: string | null;
}

export interface TombstoneRow {
  content_hash: string;
  work_title: string;
  created_at: string;
  note: string;
}

export async function countWorksByStatus(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS n FROM works GROUP BY status')
    .bind()
    .all<{ status: string; n: number }>();
  const counts: Record<string, number> = { active: 0, held: 0, removed: 0 };
  for (const r of results) counts[r.status] = r.n;
  return counts;
}

export async function totalViews(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(views), 0) AS total FROM works')
    .bind()
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listRecentWorks(db: D1Database, limit: number): Promise<AdminWorkSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, pen_name, rating, word_count, views, report_count,
              status, created_at, expires_at
       FROM works ORDER BY created_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<AdminWorkSummary>();
  return results;
}

export async function removeWork(db: D1Database, id: string, removedAt: string): Promise<void> {
  await db
    .prepare("UPDATE works SET status = 'removed', removed_at = ?1 WHERE id = ?2")
    .bind(removedAt, id)
    .run();
}

export async function restoreWork(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE works SET status = 'active', removed_at = NULL WHERE id = ?1")
    .bind(id)
    .run();
}

export async function relabelWork(
  db: D1Database,
  id: string,
  rating: string,
  warnings: string[],
  updatedAt: string,
): Promise<void> {
  await db
    .prepare('UPDATE works SET rating = ?1, warnings = ?2, updated_at = ?3 WHERE id = ?4')
    .bind(rating, JSON.stringify(warnings), updatedAt, id)
    .run();
}

export async function insertReport(db: D1Database, r: ReportRow): Promise<void> {
  await db
    .prepare('INSERT INTO reports (id, work_id, reason, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(r.id, r.work_id, r.reason, r.message, r.created_at)
    .run();
}

export async function incrementReportCount(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE works SET report_count = report_count + 1 WHERE id = ?1').bind(id).run();
}

export async function listRecentReports(db: D1Database, limit: number): Promise<RecentReport[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.work_id, r.reason, r.message, r.created_at, w.title AS work_title
       FROM reports r LEFT JOIN works w ON w.id = r.work_id
       ORDER BY r.created_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<RecentReport>();
  return results;
}

export async function listReportsForWork(db: D1Database, workId: string, limit: number): Promise<ReportRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, work_id, reason, message, created_at FROM reports WHERE work_id = ?1 ORDER BY created_at DESC LIMIT ?2',
    )
    .bind(workId, limit)
    .all<ReportRow>();
  return results;
}

export async function upsertTombstone(db: D1Database, t: TombstoneRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tombstones (content_hash, work_title, created_at, note) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(content_hash) DO UPDATE SET work_title = excluded.work_title, note = excluded.note`,
    )
    .bind(t.content_hash, t.work_title, t.created_at, t.note)
    .run();
}

export async function hasTombstone(db: D1Database, contentHash: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT content_hash FROM tombstones WHERE content_hash = ?1')
    .bind(contentHash)
    .first<{ content_hash: string }>();
  return row !== null;
}

export async function listTombstones(db: D1Database, limit: number): Promise<TombstoneRow[]> {
  const { results } = await db
    .prepare('SELECT content_hash, work_title, created_at, note FROM tombstones ORDER BY created_at DESC LIMIT ?1')
    .bind(limit)
    .all<TombstoneRow>();
  return results;
}

export async function deleteTombstone(db: D1Database, contentHash: string): Promise<void> {
  await db.prepare('DELETE FROM tombstones WHERE content_hash = ?1').bind(contentHash).run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?1')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}
