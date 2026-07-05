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
}

export async function renewWork(db: D1Database, id: string, expiresAt: string): Promise<void> {
  await db.prepare('UPDATE works SET expires_at = ?1 WHERE id = ?2').bind(expiresAt, id).run();
}

export async function incrementViews(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE works SET views = views + 1 WHERE id = ?1').bind(id).run();
}

/** Ids of unlisted works whose expiry has passed (for the daily purge). */
export async function listExpired(db: D1Database, nowIso: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM works WHERE expires_at < ?1 AND listed = 0 LIMIT ?2')
    .bind(nowIso, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export function bundleKey(id: string): string {
  return `works/${id}/bundle.json`;
}

export function pageKey(id: string): string {
  return `works/${id}/index.html`;
}
