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
  /** Compact JSON verdict from the Phase 2 shadow chain; NULL = not run. */
  moderation_verdict: string | null;
  moderation_at: string | null;
  /**
   * sha256 of the published prose (block contents only, reading order — the
   * exact tombstone recipe). Identical-prose updates skip the shadow chain;
   * the listing gate reuses a verdict whose hash still matches. NULL =
   * published before migration 0006: unknown, so the chain runs.
   */
  content_hash: string | null;
  /**
   * Phase 3 listing lifecycle: NULL (never requested) | 'pending' | 'listed'
   * | 'refused' | 'held'. Invariant: listed = 1 iff listing_state = 'listed'.
   */
  listing_state: string | null;
  /** When the work went onto the shelf; /shelf sorts by it (recency only). */
  listed_at: string | null;
  /** Author-facing gate outcome JSON (see parseListingVerdict). */
  listing_verdict: string | null;
  /**
   * The artifact the stored verdict reviewed: `${content_hash}|${rating}|
   * ${normalized warnings}` (verdictFingerprint). The listing gate reuses a
   * verdict only when this equals the current bundle+labels fingerprint —
   * so changed content or changed labels can never ride a stale verdict onto
   * the shelf. NULL = no reusable verdict.
   */
  verdict_fingerprint: string | null;
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
  content_hash: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  /** PBKDF2 hash when the work is published already-locked; else NULL. */
  password_hash?: string | null;
}

export interface WorkUpdate {
  title: string;
  pen_name: string;
  language: string;
  rating: string;
  warnings: string[];
  word_count: number;
  first_line: string;
  content_hash: string;
  updated_at: string;
  /**
   * True when the content or labels actually changed. Then the stored
   * moderation verdict no longer describes this artifact, so it is cleared,
   * and any public listing is dropped in the SAME statement — a listed work
   * cannot be silently mutated out from under the review that approved it
   * (the central listing-integrity rule). False = idempotent re-push:
   * verdict and listing stand.
   */
  resetModeration: boolean;
}

export async function getWork(db: D1Database, id: string): Promise<WorkRow | null> {
  return await db.prepare('SELECT * FROM works WHERE id = ?1').bind(id).first<WorkRow>();
}

export async function insertWork(db: D1Database, w: NewWork): Promise<void> {
  await db
    .prepare(
      `INSERT INTO works
        (id, secret_hash, title, pen_name, language, rating, warnings,
         word_count, first_line, content_hash, created_at, updated_at, expires_at, password_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
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
      w.content_hash,
      w.created_at,
      w.updated_at,
      w.expires_at,
      w.password_hash ?? null,
    )
    .run();
}

export async function updateWork(db: D1Database, id: string, u: WorkUpdate): Promise<void> {
  // On a real change, atomically clear the now-stale verdict AND drop any
  // listing — one statement so no window exists where a listed work serves
  // changed content while still marked reviewed.
  const resetClause = u.resetModeration
    ? `, moderation_verdict = NULL, moderation_at = NULL, verdict_fingerprint = NULL,
       listing_state = NULL, listed = 0, listed_at = NULL, listing_verdict = NULL`
    : '';
  await db
    .prepare(
      `UPDATE works SET title = ?1, pen_name = ?2, language = ?3, rating = ?4, warnings = ?5,
         word_count = ?6, first_line = ?7, content_hash = ?8, updated_at = ?9${resetClause}
       WHERE id = ?10`,
    )
    .bind(
      u.title,
      u.pen_name,
      u.language,
      u.rating,
      JSON.stringify(u.warnings),
      u.word_count,
      u.first_line,
      u.content_hash,
      u.updated_at,
      id,
    )
    .run();
}

export async function deleteWork(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM works WHERE id = ?1').bind(id).run();
  // Reports about a gone work carry no weight and no context — evaporate too.
  await db.prepare('DELETE FROM reports WHERE work_id = ?1').bind(id).run();
  // Letters are the author's private mail; when the work goes, they go.
  await db.prepare('DELETE FROM letters WHERE work_id = ?1').bind(id).run();
}

/** Set (pbkdf2$... string) or clear (null) the work's password gate. */
export async function setPasswordHash(db: D1Database, id: string, hash: string | null): Promise<void> {
  await db.prepare('UPDATE works SET password_hash = ?1 WHERE id = ?2').bind(hash, id).run();
}

export async function setLettersOpen(db: D1Database, id: string, open: boolean): Promise<void> {
  await db.prepare('UPDATE works SET letters_open = ?1 WHERE id = ?2').bind(open ? 1 : 0, id).run();
}

export async function renewWork(db: D1Database, id: string, expiresAt: string): Promise<void> {
  await db.prepare('UPDATE works SET expires_at = ?1 WHERE id = ?2').bind(expiresAt, id).run();
}

/**
 * Store a moderation verdict, bound to the exact content it reviewed.
 *
 * The `WHERE content_hash = reviewedHash` guard is load-bearing: a chain run
 * is scheduled against a snapshot of the prose, but the author may update the
 * work (new content_hash) before the run finishes. Without the guard a late
 * verdict for superseded content would overwrite the row and could then be
 * reused by the listing gate. With it, such a run silently matches zero rows.
 * (An unpublished-mid-run work matches zero rows too — also by design.)
 *
 * `fingerprint` (verdictFingerprint of the reviewed bundle+labels) is stored
 * alongside so the gate can prove the verdict belongs to the current artifact.
 */
export async function setModerationVerdict(
  db: D1Database,
  id: string,
  verdictJson: string,
  atIso: string,
  reviewedHash: string,
  fingerprint: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE works SET moderation_verdict = ?1, moderation_at = ?2, verdict_fingerprint = ?3
       WHERE id = ?4 AND content_hash = ?5`,
    )
    .bind(verdictJson, atIso, fingerprint, id, reviewedHash)
    .run();
}

// ---------- listing lifecycle (Phase 3) ----------

/** Author asked for a listing; the gate (or the operator) will resolve it. */
export async function markListingPending(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      "UPDATE works SET listing_state = 'pending', listed = 0, listed_at = NULL, listing_verdict = NULL WHERE id = ?1",
    )
    .bind(id)
    .run();
}

/**
 * Gate outcome. The WHERE guard makes the write land ONLY while the request
 * is still pending — an author who delists (or unpublishes) mid-run must not
 * be listed against their will by a slow chain. The caller re-reads the row
 * before any Discord ping so a skipped write also skips the noise.
 */
export async function resolveListingPending(
  db: D1Database,
  id: string,
  state: 'listed' | 'refused' | 'held',
  listedAt: string | null,
  verdictJson: string | null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE works SET listing_state = ?1, listed = ?2, listed_at = ?3, listing_verdict = ?4 WHERE id = ?5 AND listing_state = 'pending'",
    )
    .bind(state, state === 'listed' ? 1 : 0, listedAt, verdictJson, id)
    .run();
}

/** Operator approve/deny — unconditional (the route checked the state). */
export async function setListingResolved(
  db: D1Database,
  id: string,
  state: 'listed' | 'refused' | 'held',
  listedAt: string | null,
  verdictJson: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE works SET listing_state = ?1, listed = ?2, listed_at = ?3, listing_verdict = ?4 WHERE id = ?5')
    .bind(state, state === 'listed' ? 1 : 0, listedAt, verdictJson, id)
    .run();
}

/** Back to never-requested. Always allowed; also used by operator removal. */
export async function delistWork(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('UPDATE works SET listing_state = NULL, listed = 0, listed_at = NULL, listing_verdict = NULL WHERE id = ?1')
    .bind(id)
    .run();
}

// ---------- the shelf browse query (Phase 3) ----------

export interface ShelfFilters {
  rating: string | null;
  language: string | null;
}

/** One /shelf card. `warnings` stays JSON-encoded like the row. */
export interface ShelfCard {
  id: string;
  title: string;
  pen_name: string;
  language: string;
  rating: string;
  warnings: string;
  word_count: number;
  first_line: string;
  listed_at: string | null;
}

function shelfWhere(f: ShelfFilters): { clause: string; args: unknown[] } {
  const where = ['listed = 1', "status = 'active'"];
  const args: unknown[] = [];
  if (f.rating !== null) {
    args.push(f.rating);
    where.push(`rating = ?${args.length}`);
  }
  if (f.language !== null) {
    args.push(f.language);
    where.push(`language = ?${args.length}`);
  }
  return { clause: where.join(' AND '), args };
}

/** Newest listing first — recency and filters only, never popularity. */
export async function listShelfWorks(
  db: D1Database,
  f: ShelfFilters,
  limit: number,
  offset: number,
): Promise<ShelfCard[]> {
  const { clause, args } = shelfWhere(f);
  const { results } = await db
    .prepare(
      `SELECT id, title, pen_name, language, rating, warnings, word_count, first_line, listed_at
       FROM works WHERE ${clause}
       ORDER BY listed_at DESC, id DESC LIMIT ?${args.length + 1} OFFSET ?${args.length + 2}`,
    )
    .bind(...args, limit, offset)
    .all<ShelfCard>();
  return results;
}

export async function countShelfWorks(db: D1Database, f: ShelfFilters): Promise<number> {
  const { clause, args } = shelfWhere(f);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM works WHERE ${clause}`)
    .bind(...args)
    .first<{ n: number }>();
  return row?.n ?? 0;
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

/** True iff a work row with this id exists (cron orphan sweep). */
export async function workExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS n FROM works WHERE id = ?1').bind(id).first<{ n: number }>();
  return row !== null;
}

/**
 * Rows that violate the core listing invariant (listed = 1 implies
 * listing_state='listed', status='active', and no password). Should always
 * be empty; the daily cron alerts if it is not — a canary, no auto-fix.
 */
export async function listInvariantViolations(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM works
       WHERE listed = 1 AND (listing_state != 'listed' OR status != 'active' OR password_hash IS NOT NULL)
       LIMIT ?1`,
    )
    .bind(limit)
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

// ---------- letters (reader → author, private) ----------

export interface LetterRow {
  id: string;
  work_id: string;
  body: string;
  contact: string;
  created_at: string;
}

/** The shape the author sees — work_id is implied by the route. */
export interface AuthorLetter {
  id: string;
  body: string;
  contact: string;
  created_at: string;
}

export async function insertLetter(db: D1Database, l: LetterRow): Promise<void> {
  await db
    .prepare('INSERT INTO letters (id, work_id, body, contact, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(l.id, l.work_id, l.body, l.contact, l.created_at)
    .run();
}

/** Newest first (rowid breaks same-millisecond ties). */
export async function listLetters(db: D1Database, workId: string, limit: number): Promise<AuthorLetter[]> {
  const { results } = await db
    .prepare(
      `SELECT id, body, contact, created_at FROM letters
       WHERE work_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2`,
    )
    .bind(workId, limit)
    .all<AuthorLetter>();
  return results;
}

export async function deleteLetter(db: D1Database, workId: string, letterId: string): Promise<void> {
  await db.prepare('DELETE FROM letters WHERE id = ?1 AND work_id = ?2').bind(letterId, workId).run();
}

/** Per-work storage cap: evict the oldest rows beyond `keep`. */
export async function evictLettersBeyond(db: D1Database, workId: string, keep: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM letters WHERE work_id = ?1 AND id NOT IN (
         SELECT id FROM letters WHERE work_id = ?1
         ORDER BY created_at DESC, rowid DESC LIMIT ?2
       )`,
    )
    .bind(workId, keep)
    .run();
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
  /** 0/1 — whether a password gate is set (the hash itself never leaves). */
  password_protected: number;
  /** 'pass' | 'tag-fix' | 'hold' | 'error' — NULL when the chain hasn't run. */
  moderation_outcome: string | null;
  /** 'pending' | 'listed' | 'refused' | 'held' — NULL when never requested. */
  listing_state: string | null;
  created_at: string;
  expires_at: string;
}

/** A held listing request awaiting the operator's approve/deny. */
export interface HeldListing {
  id: string;
  title: string;
  pen_name: string;
  rating: string;
  /** Raw JSON — the route parses it before it leaves. */
  listing_verdict: string | null;
  updated_at: string;
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

/** Pull only the outcome out of a stored verdict JSON (overview rows). */
function verdictOutcome(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const outcome = (parsed as Record<string, unknown>)['outcome'];
      if (typeof outcome === 'string') return outcome;
    }
  } catch {
    /* written by us, but never trust a parse */
  }
  return null;
}

export async function listRecentWorks(db: D1Database, limit: number): Promise<AdminWorkSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, pen_name, rating, word_count, views, report_count,
              status, (password_hash IS NOT NULL) AS password_protected,
              moderation_verdict, listing_state, created_at, expires_at
       FROM works ORDER BY created_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<Omit<AdminWorkSummary, 'moderation_outcome'> & { moderation_verdict: string | null }>();
  return results.map(({ moderation_verdict, ...rest }) => ({
    ...rest,
    moderation_outcome: verdictOutcome(moderation_verdict),
  }));
}

/** Held listing requests, oldest decision first (the operator's queue). */
export async function listHeldListings(db: D1Database, limit: number): Promise<HeldListing[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, pen_name, rating, listing_verdict, updated_at
       FROM works WHERE listing_state = 'held' ORDER BY updated_at ASC LIMIT ?1`,
    )
    .bind(limit)
    .all<HeldListing>();
  return results;
}

/** Operator removal also delists — a removed work must never sit on /shelf. */
export async function removeWork(db: D1Database, id: string, removedAt: string): Promise<void> {
  await db
    .prepare(
      `UPDATE works SET status = 'removed', removed_at = ?1,
         listing_state = NULL, listed = 0, listed_at = NULL, listing_verdict = NULL
       WHERE id = ?2`,
    )
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
  delist: boolean,
): Promise<void> {
  // The stored verdict answered "is this honestly labeled?" against the OLD
  // labels, so a relabel stales it: NULL the verdict + its fingerprint so no
  // later gate reuses a pre-relabel judgment.
  //
  // delist=true (the AUTHOR path): a label change on a listed/pending/held
  // work also drops the listing — an author cannot downgrade a rating while
  // staying on the public shelf. The accept-suggested-labels flow re-requests
  // the listing afterward, so the fresh gate sees the new labels.
  // delist=false (the OPERATOR relabel): the operator IS the moderator, so
  // the listing stands; only the cached verdict is staled.
  const delistClause = delist
    ? ', listing_state = NULL, listed = 0, listed_at = NULL, listing_verdict = NULL'
    : '';
  await db
    .prepare(
      `UPDATE works SET rating = ?1, warnings = ?2, updated_at = ?3,
         moderation_verdict = NULL, moderation_at = NULL, verdict_fingerprint = NULL${delistClause}
       WHERE id = ?4`,
    )
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

/**
 * Atomically bump a settings counter and return the new value (the chain
 * budget's check-and-increment). A single SQLite upsert with RETURNING is
 * race-free on its own, and D1 additionally executes statements against a
 * database serially — no read-modify-write window either way.
 */
export async function incrementCounter(db: D1Database, key: string): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?1, '1') " +
        'ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value',
    )
    .bind(key)
    .first<{ value: string | number }>();
  return Number(row?.value ?? 0);
}
