import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './worker';
import type { Env } from './worker/lib/env';
import type { WorkRow } from './worker/lib/db';
import { chainRunsKey } from './worker/lib/moderation';
import { PUBLISH_BUNDLE_KIND, PUBLISH_BUNDLE_VERSION, type PublishBundleV1 } from './format';

// ---------- minimal fakes ----------

class FakeR2 {
  store = new Map<string, string>();
  async put(key: string, value: string | ArrayBuffer): Promise<unknown> {
    this.store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
    return {};
  }
  async get(key: string): Promise<{ body: string; text(): Promise<string> } | null> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return { body: v, text: async () => v };
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }
  async list(opts?: { prefix?: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: false;
    delimitedPrefixes: string[];
  }> {
    const prefix = opts?.prefix ?? '';
    const objects = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key }));
    return { objects, truncated: false, delimitedPrefixes: [] };
  }
  keysWithPrefix(prefix: string): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

interface FakeReport {
  id: string;
  work_id: string;
  reason: string;
  message: string;
  created_at: string;
}

interface FakeTombstone {
  content_hash: string;
  work_title: string;
  created_at: string;
  note: string;
}

interface FakeLetter {
  id: string;
  work_id: string;
  body: string;
  contact: string;
  created_at: string;
}

/** Understands exactly the SQL statements in src/worker/lib/db.ts. */
class FakeD1 {
  works = new Map<string, WorkRow>();
  reports: FakeReport[] = [];
  tombstones = new Map<string, FakeTombstone>();
  settings = new Map<string, string>();
  /** Insertion order = rowid order (oldest first), like the real table. */
  letters: FakeLetter[] = [];
  prepare(sql: string): { bind(...args: unknown[]): FakeStatement } {
    const db = this;
    return {
      bind(...args: unknown[]): FakeStatement {
        return new FakeStatement(sql, args, db);
      },
    };
  }
}

class FakeStatement {
  constructor(
    private sql: string,
    private args: unknown[],
    private db: FakeD1,
  ) {}

  private get works(): Map<string, WorkRow> {
    return this.db.works;
  }

  /** Filtered + ordered rows for the /shelf queries (list + count). */
  private shelfRows(): WorkRow[] {
    const s = this.sql;
    let i = 0;
    const rating = s.includes('rating = ?') ? String(this.args[i++]) : null;
    const language = s.includes('language = ?') ? String(this.args[i++]) : null;
    return [...this.works.values()]
      .filter(
        (w) =>
          w.listed === 1 &&
          w.status === 'active' &&
          (rating === null || w.rating === rating) &&
          (language === null || w.language === language),
      )
      .sort((a, b) => {
        const la = a.listed_at ?? '';
        const lb = b.listed_at ?? '';
        if (la !== lb) return la < lb ? 1 : -1;
        return a.id < b.id ? 1 : -1;
      });
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    if (s.includes('SELECT * FROM works WHERE id')) {
      return (this.works.get(String(this.args[0])) as T | undefined) ?? null;
    }
    // incrementCounter — the chain budget's atomic upsert with RETURNING.
    if (s.includes('ON CONFLICT(key) DO UPDATE SET value = CAST')) {
      const key = String(this.args[0]);
      const next = Number(this.db.settings.get(key) ?? '0') + 1;
      this.db.settings.set(key, String(next));
      return { value: String(next) } as T;
    }
    if (s.includes('COUNT(*) AS n FROM works WHERE listed = 1')) {
      return { n: this.shelfRows().length } as T;
    }
    if (s.includes('SELECT value FROM settings')) {
      const v = this.db.settings.get(String(this.args[0]));
      return v === undefined ? null : ({ value: v } as T);
    }
    if (s.includes('SELECT content_hash FROM tombstones')) {
      const t = this.db.tombstones.get(String(this.args[0]));
      return t === undefined ? null : ({ content_hash: t.content_hash } as T);
    }
    if (s.includes('COALESCE(SUM(views)')) {
      let total = 0;
      for (const w of this.works.values()) total += w.views;
      return { total } as T;
    }
    throw new Error(`FakeD1 unhandled first(): ${s}`);
  }

  async run(): Promise<{ success: boolean }> {
    const s = this.sql;
    const a = this.args;
    if (s.includes('INSERT INTO works')) {
      const [id, secret_hash, title, pen_name, language, rating, warnings, word_count, first_line, content_hash, created_at, updated_at, expires_at] = a;
      this.works.set(String(id), {
        id: String(id),
        secret_hash: String(secret_hash),
        title: String(title),
        pen_name: String(pen_name),
        language: String(language),
        rating: String(rating),
        warnings: String(warnings),
        word_count: Number(word_count),
        first_line: String(first_line),
        content_hash: String(content_hash),
        status: 'active',
        listed: 0,
        password_hash: null,
        views: 0,
        letters_open: 1,
        report_count: 0,
        created_at: String(created_at),
        updated_at: String(updated_at),
        expires_at: String(expires_at),
        removed_at: null,
        moderation_verdict: null,
        moderation_at: null,
        listing_state: null,
        listed_at: null,
        listing_verdict: null,
      });
      return { success: true };
    }
    if (s.includes('SET moderation_verdict')) {
      const row = this.works.get(String(a[2]));
      if (row) {
        row.moderation_verdict = String(a[0]);
        row.moderation_at = String(a[1]);
      }
      return { success: true };
    }
    if (s.includes("SET listing_state = 'pending'")) {
      const row = this.works.get(String(a[0]));
      if (row) {
        row.listing_state = 'pending';
        row.listed = 0;
        row.listed_at = null;
        row.listing_verdict = null;
      }
      return { success: true };
    }
    if (s.includes('SET listing_state = NULL')) {
      // delistWork — also part of removeWork, handled separately below.
      const row = this.works.get(String(a[0]));
      if (row) {
        row.listing_state = null;
        row.listed = 0;
        row.listed_at = null;
        row.listing_verdict = null;
      }
      return { success: true };
    }
    if (s.includes('SET listing_state = ?1')) {
      const row = this.works.get(String(a[4]));
      const guarded = s.includes("AND listing_state = 'pending'");
      if (row && (!guarded || row.listing_state === 'pending')) {
        row.listing_state = String(a[0]);
        row.listed = Number(a[1]);
        row.listed_at = a[2] === null ? null : String(a[2]);
        row.listing_verdict = a[3] === null ? null : String(a[3]);
      }
      return { success: true };
    }
    if (s.includes('SET views = views + 1')) {
      const row = this.works.get(String(a[0]));
      if (row) row.views += 1;
      return { success: true };
    }
    if (s.includes('report_count = report_count + 1')) {
      const row = this.works.get(String(a[0]));
      if (row) row.report_count += 1;
      return { success: true };
    }
    if (s.includes('SET expires_at')) {
      const row = this.works.get(String(a[1]));
      if (row) row.expires_at = String(a[0]);
      return { success: true };
    }
    if (s.includes('UPDATE works SET title')) {
      const row = this.works.get(String(a[7]));
      if (row) {
        row.title = String(a[0]);
        row.rating = String(a[1]);
        row.warnings = String(a[2]);
        row.word_count = Number(a[3]);
        row.first_line = String(a[4]);
        row.content_hash = String(a[5]);
        row.updated_at = String(a[6]);
      }
      return { success: true };
    }
    if (s.includes("SET status = 'removed'")) {
      const row = this.works.get(String(a[1]));
      if (row) {
        row.status = 'removed';
        row.removed_at = String(a[0]);
        // Operator removal also delists (see removeWork in db.ts).
        row.listing_state = null;
        row.listed = 0;
        row.listed_at = null;
        row.listing_verdict = null;
      }
      return { success: true };
    }
    if (s.includes("SET status = 'active'")) {
      const row = this.works.get(String(a[0]));
      if (row) {
        row.status = 'active';
        row.removed_at = null;
      }
      return { success: true };
    }
    if (s.includes('UPDATE works SET rating')) {
      const row = this.works.get(String(a[3]));
      if (row) {
        row.rating = String(a[0]);
        row.warnings = String(a[1]);
        row.updated_at = String(a[2]);
        // Relabel stales the cached verdict (see relabelWork in db.ts).
        row.content_hash = null;
      }
      return { success: true };
    }
    if (s.includes('UPDATE works SET password_hash')) {
      const row = this.works.get(String(a[1]));
      if (row) row.password_hash = a[0] === null ? null : String(a[0]);
      return { success: true };
    }
    if (s.includes('UPDATE works SET letters_open')) {
      const row = this.works.get(String(a[1]));
      if (row) row.letters_open = Number(a[0]);
      return { success: true };
    }
    if (s.includes('INSERT INTO letters')) {
      const [id, work_id, body, contact, created_at] = a;
      this.db.letters.push({
        id: String(id),
        work_id: String(work_id),
        body: String(body),
        contact: String(contact),
        created_at: String(created_at),
      });
      return { success: true };
    }
    if (s.includes('DELETE FROM letters WHERE id')) {
      const [letterId, workId] = a;
      this.db.letters = this.db.letters.filter(
        (l) => !(l.id === String(letterId) && l.work_id === String(workId)),
      );
      return { success: true };
    }
    if (s.includes('DELETE FROM letters') && s.includes('NOT IN')) {
      // Eviction: keep the newest ?2 letters of the work (insertion order =
      // rowid order breaks same-timestamp ties, like the real query).
      const workId = String(a[0]);
      const keep = Number(a[1]);
      const mine = this.db.letters.filter((l) => l.work_id === workId);
      const survivors = new Set(mine.slice(Math.max(0, mine.length - keep)).map((l) => l.id));
      this.db.letters = this.db.letters.filter((l) => l.work_id !== workId || survivors.has(l.id));
      return { success: true };
    }
    if (s.includes('DELETE FROM letters WHERE work_id')) {
      this.db.letters = this.db.letters.filter((l) => l.work_id !== String(a[0]));
      return { success: true };
    }
    if (s.includes('INSERT INTO reports')) {
      const [id, work_id, reason, message, created_at] = a;
      this.db.reports.push({
        id: String(id),
        work_id: String(work_id),
        reason: String(reason),
        message: String(message),
        created_at: String(created_at),
      });
      return { success: true };
    }
    if (s.includes('INSERT INTO tombstones')) {
      const [content_hash, work_title, created_at, note] = a;
      this.db.tombstones.set(String(content_hash), {
        content_hash: String(content_hash),
        work_title: String(work_title),
        created_at: String(created_at),
        note: String(note),
      });
      return { success: true };
    }
    if (s.includes('INSERT INTO settings')) {
      this.db.settings.set(String(a[0]), String(a[1]));
      return { success: true };
    }
    if (s.includes('DELETE FROM works WHERE id')) {
      this.works.delete(String(a[0]));
      return { success: true };
    }
    if (s.includes('DELETE FROM reports WHERE work_id')) {
      this.db.reports = this.db.reports.filter((r) => r.work_id !== String(a[0]));
      return { success: true };
    }
    if (s.includes('DELETE FROM tombstones')) {
      this.db.tombstones.delete(String(a[0]));
      return { success: true };
    }
    throw new Error(`FakeD1 unhandled run(): ${s}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql;
    if (s.includes('SELECT id FROM works WHERE expires_at')) {
      const now = String(this.args[0]);
      const limit = Number(this.args[1]);
      const results = [...this.works.values()]
        .filter((w) => w.expires_at < now && w.listed === 0 && w.status !== 'removed')
        .slice(0, limit)
        .map((w) => ({ id: w.id }) as T);
      return { results };
    }
    if (s.includes("WHERE status = 'removed' AND removed_at")) {
      const cutoff = String(this.args[0]);
      const limit = Number(this.args[1]);
      const results = [...this.works.values()]
        .filter((w) => w.status === 'removed' && w.removed_at !== null && w.removed_at < cutoff)
        .slice(0, limit)
        .map((w) => ({ id: w.id }) as T);
      return { results };
    }
    if (s.includes('GROUP BY status')) {
      const counts = new Map<string, number>();
      for (const w of this.works.values()) counts.set(w.status, (counts.get(w.status) ?? 0) + 1);
      return { results: [...counts.entries()].map(([status, n]) => ({ status, n }) as T) };
    }
    if (s.includes('FROM works ORDER BY created_at DESC')) {
      const limit = Number(this.args[0]);
      const results = [...this.works.values()]
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map((w) => ({
          id: w.id, title: w.title, pen_name: w.pen_name, rating: w.rating,
          word_count: w.word_count, views: w.views, report_count: w.report_count,
          status: w.status, password_protected: w.password_hash !== null ? 1 : 0,
          moderation_verdict: w.moderation_verdict, listing_state: w.listing_state,
          created_at: w.created_at, expires_at: w.expires_at,
        }) as T);
      return { results };
    }
    if (s.includes("WHERE listing_state = 'held'")) {
      const limit = Number(this.args[0]);
      const results = [...this.works.values()]
        .filter((w) => w.listing_state === 'held')
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))
        .slice(0, limit)
        .map((w) => ({
          id: w.id, title: w.title, pen_name: w.pen_name, rating: w.rating,
          listing_verdict: w.listing_verdict, updated_at: w.updated_at,
        }) as T);
      return { results };
    }
    if (s.includes('FROM works WHERE listed = 1')) {
      const limit = Number(this.args[this.args.length - 2]);
      const offset = Number(this.args[this.args.length - 1]);
      const results = this.shelfRows()
        .slice(offset, offset + limit)
        .map((w) => ({
          id: w.id, title: w.title, pen_name: w.pen_name, language: w.language,
          rating: w.rating, warnings: w.warnings, word_count: w.word_count,
          first_line: w.first_line, listed_at: w.listed_at,
        }) as T);
      return { results };
    }
    if (s.includes('FROM letters')) {
      const workId = String(this.args[0]);
      const limit = Number(this.args[1]);
      // Newest first: reverse insertion order (rowid DESC breaks ties).
      const results = this.db.letters
        .filter((l) => l.work_id === workId)
        .reverse()
        .slice(0, limit)
        .map((l) => ({ id: l.id, body: l.body, contact: l.contact, created_at: l.created_at }) as T);
      return { results };
    }
    if (s.includes('FROM reports r LEFT JOIN')) {
      const limit = Number(this.args[0]);
      const results = [...this.db.reports]
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map((r) => ({ ...r, work_title: this.works.get(r.work_id)?.title ?? null }) as T);
      return { results };
    }
    if (s.includes('FROM reports WHERE work_id')) {
      const workId = String(this.args[0]);
      const limit = Number(this.args[1]);
      const results = this.db.reports
        .filter((r) => r.work_id === workId)
        .slice(0, limit)
        .map((r) => ({ ...r }) as T);
      return { results };
    }
    if (s.includes('FROM tombstones ORDER BY')) {
      const limit = Number(this.args[0]);
      const results = [...this.db.tombstones.values()].slice(0, limit).map((t) => ({ ...t }) as T);
      return { results };
    }
    throw new Error(`FakeD1 unhandled all(): ${s}`);
  }
}

class FakeRateLimit {
  keys: string[] = [];
  success = true;
  async limit(opts: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(opts.key);
    return { success: this.success };
  }
}

function makeCtx(): { ctx: ExecutionContext; drain(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, drain: async () => void (await Promise.all(pending)) };
}

interface Harness {
  env: Env;
  r2: FakeR2;
  d1: FakeD1;
  rlPublish: FakeRateLimit;
  rlManage: FakeRateLimit;
  rlReport: FakeRateLimit;
  rlViews: FakeRateLimit;
  rlUnlock: FakeRateLimit;
  rlLetter: FakeRateLimit;
}

function makeEnv(overrides: Partial<Env> = {}): Harness {
  const r2 = new FakeR2();
  const d1 = new FakeD1();
  const rlPublish = new FakeRateLimit();
  const rlManage = new FakeRateLimit();
  const rlReport = new FakeRateLimit();
  const rlViews = new FakeRateLimit();
  const rlUnlock = new FakeRateLimit();
  const rlLetter = new FakeRateLimit();
  const env = {
    SHELF_R2: r2 as unknown as R2Bucket,
    SHELF_DB: d1 as unknown as D1Database,
    RL_PUBLISH: rlPublish,
    RL_MANAGE: rlManage,
    RL_REPORT: rlReport,
    RL_VIEWS: rlViews,
    RL_UNLOCK: rlUnlock,
    RL_LETTER: rlLetter,
    ...overrides,
  } satisfies Env;
  return { env, r2, d1, rlPublish, rlManage, rlReport, rlViews, rlUnlock, rlLetter };
}

function makeBundle(overrides: Partial<PublishBundleV1> = {}): PublishBundleV1 {
  return {
    kind: PUBLISH_BUNDLE_KIND,
    version: PUBLISH_BUNDLE_VERSION,
    app_version: '0.11.3',
    title: 'A Quiet Book',
    pen_name: 'Á. Péteri',
    language: 'en',
    rating: 'general',
    warnings: [],
    document: { synopsis: '', pov_character_id: null },
    chapters: [{ id: 'ch1', title: 'One', order: 0, kind: 'standard' }],
    blocks: [
      {
        id: 'b1',
        chapter_id: 'ch1',
        type: 'text',
        content: 'Two hearts, one soul. The rest is rain.',
        order: 0,
        metadata: { type: 'text' },
      },
    ],
    characters: [],
    ...overrides,
  };
}

/** Three standard chapters — bakes as cover + 3 chapter pages. */
function makeBundle3(overrides: Partial<PublishBundleV1> = {}): PublishBundleV1 {
  return makeBundle({
    chapters: [
      { id: 'c1', title: 'One', order: 0, kind: 'standard' },
      { id: 'c2', title: 'Two', order: 1, kind: 'standard' },
      { id: 'c3', title: 'Three', order: 2, kind: 'standard' },
    ],
    blocks: [
      { id: 'b1', chapter_id: 'c1', type: 'text', content: 'First chapter prose.', order: 0, metadata: { type: 'text' } },
      { id: 'b2', chapter_id: 'c2', type: 'text', content: 'Second chapter prose.', order: 1, metadata: { type: 'text' } },
      { id: 'b3', chapter_id: 'c3', type: 'text', content: 'Third chapter prose.', order: 2, metadata: { type: 'text' } },
    ],
    ...overrides,
  });
}

const BASE = 'https://shelf.inkmirror.cc';

async function dispatch(h: Harness, req: Request): Promise<Response> {
  const { ctx, drain } = makeCtx();
  const res = await worker.fetch(req, h.env, ctx);
  await drain();
  return res;
}

async function publish(h: Harness, bundle = makeBundle()): Promise<{ id: string; url: string; manageSecret: string }> {
  const res = await dispatch(
    h,
    new Request(`${BASE}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; url: string; manageSecret: string };
}

// ---------- tests ----------

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/publish', () => {
  it('happy path: 22-char id, manage secret, two R2 objects, D1 row', async () => {
    const h = makeEnv();
    const out = await publish(h);
    expect(out.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(out.url).toBe(`${BASE}/w/${out.id}`);
    expect(out.manageSecret.length).toBeGreaterThanOrEqual(43);
    expect(h.r2.store.has(`works/${out.id}/bundle.json`)).toBe(true);
    expect(h.r2.store.has(`works/${out.id}/index.html`)).toBe(true);
    const row = h.d1.works.get(out.id);
    expect(row).toBeDefined();
    expect(row?.word_count).toBe(8);
    expect(row?.first_line).toBe('Two hearts, one soul.');
    expect(row?.secret_hash).not.toContain(out.manageSecret);
  });

  it('rejects an unstripped bundle (block carrying deleted_at) with 400', async () => {
    const h = makeEnv();
    const bad = makeBundle();
    const block = bad.blocks[0] as unknown as Record<string, unknown>;
    block['deleted_at'] = null; // graveyard field — presence alone is the tell
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('invalid_bundle');
    expect(body.detail).toContain('deleted_at');
    expect(h.r2.store.size).toBe(0);
    expect(h.d1.works.size).toBe(0);
  });

  it('reflects an allowed origin with Vary: Origin, and handles preflight', async () => {
    const h = makeEnv();
    const pre = await dispatch(
      h,
      new Request(`${BASE}/api/publish`, {
        method: 'OPTIONS',
        headers: { origin: 'https://inkmirror.cc', 'access-control-request-method': 'POST' },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://inkmirror.cc');
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-manage-secret');
    expect(pre.headers.get('vary')?.toLowerCase()).toBe('origin');

    const evil = await dispatch(
      h,
      new Request(`${BASE}/api/publish`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      }),
    );
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects oversized bodies via content-length', async () => {
    const h = makeEnv();
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024) },
        body: '{}',
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe('manage routes', () => {
  it('wrong secret → 404, indistinguishable from a nonexistent id', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    const wrong = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, { headers: { 'x-manage-secret': 'not-the-secret' } }),
    );
    const missing = await dispatch(
      h,
      new Request(`${BASE}/api/works/AAAAAAAAAAAAAAAAAAAAAA`, { headers: { 'x-manage-secret': 'not-the-secret' } }),
    );
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await wrong.text()).toBe(await missing.text());
  });

  it('correct secret → meta JSON with views and expiry', async () => {
    const h = makeEnv();
    const { id, manageSecret, url } = await publish(h);
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, { headers: { 'x-manage-secret': manageSecret } }),
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta['title']).toBe('A Quiet Book');
    expect(meta['views']).toBe(0);
    expect(meta['url']).toBe(url);
    expect(typeof meta['expires_at']).toBe('string');
  });

  it('renew pushes expiry forward; delete removes row and both R2 objects', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    const before = h.d1.works.get(id)?.expires_at ?? '';
    h.d1.works.get(id)!.expires_at = new Date(Date.now() + 1000).toISOString();

    const renew = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/renew`, { method: 'POST', headers: { 'x-manage-secret': manageSecret } }),
    );
    expect(renew.status).toBe(200);
    expect(h.d1.works.get(id)!.expires_at >= before).toBe(true);

    const del = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, { method: 'DELETE', headers: { 'x-manage-secret': manageSecret } }),
    );
    expect(del.status).toBe(200);
    expect(h.d1.works.has(id)).toBe(false);
    expect(h.r2.store.size).toBe(0);
  });

  it('PUT re-bakes the page and updates D1', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    const updated = makeBundle({ title: 'A Louder Book', rating: 'mature' });
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-manage-secret': manageSecret },
        body: JSON.stringify(updated),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.d1.works.get(id)?.title).toBe('A Louder Book');
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('A Louder Book');
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('age-gate');
  });
});

describe('POST /api/works/:id/report', () => {
  const WORK = 'AAAAAAAAAAAAAAAAAAAAAA';

  function formReport(fields: Record<string, string>): Request {
    return new Request(`${BASE}/api/works/${WORK}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it('filled honeypot → silently accepted, webhook NOT called', async () => {
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const res = await dispatch(
      h,
      formReport({ reason: 'other', message: 'spam', website: 'https://spam.example', ts: String(Date.now() - 5000) }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Thank you');
    expect(fetch).not.toHaveBeenCalled();
    expect(h.d1.reports).toHaveLength(0);
  });

  it('too-fast submit (render gate) → silently accepted, webhook NOT called', async () => {
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const res = await dispatch(h, formReport({ reason: 'other', message: '', website: '', ts: String(Date.now()) }));
    expect(res.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.d1.reports).toHaveLength(0);
  });

  it('legit form report → mirrored to D1, count bumped, webhook called, styled confirmation page', async () => {
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id } = await publish(h);
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ reason: 'mislabeled', message: 'rated general, is not', website: '', ts: String(Date.now() - 5000) }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('a human will look at this');

    // D1 is the durable record — written before the Discord forward.
    expect(h.d1.reports).toHaveLength(1);
    expect(h.d1.reports[0]?.work_id).toBe(id);
    expect(h.d1.reports[0]?.reason).toBe('mislabeled');
    expect(h.d1.reports[0]?.message).toBe('rated general, is not');
    expect(h.d1.works.get(id)?.report_count).toBe(1);

    expect(fetch).toHaveBeenCalledOnce();
    const [hookUrl, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(hookUrl).toBe('https://discord.example/hook');
    expect(String(init.body)).toContain('mislabeled');
    expect(String(init.body)).toContain(id);
  });

  it('Discord failure does not lose the D1 record and still answers ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id } = await publish(h);
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'other', message: 'x', website: '', ts: Date.now() - 5000 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.d1.reports).toHaveLength(1);
    expect(h.d1.works.get(id)?.report_count).toBe(1);
  });

  it('JSON report gets a JSON response', async () => {
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/works/${WORK}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'plagiarism', message: '', website: '', ts: Date.now() - 5000 }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it('webhook unset → still accepted, D1 keeps the record (Discord is only the doorbell)', async () => {
    const h = makeEnv();
    const res = await dispatch(h, formReport({ reason: 'other', message: '', website: '', ts: String(Date.now() - 5000) }));
    expect(res.status).toBe(200);
    expect(h.d1.reports).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('GET /w/:id', () => {
  it('serves the baked page with cache and noindex headers, and counts a view', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    const res = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await res.text()).toContain('A Quiet Book');
    expect(h.d1.works.get(id)?.views).toBe(1);
    expect(h.rlViews.keys[0]).toContain(id);
  });

  it('view cooldown active → served but not counted', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    h.rlViews.success = false;
    const res = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(res.status).toBe(200);
    expect(h.d1.works.get(id)?.views).toBe(0);
  });

  it('expired work → 404 not-found page', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    h.d1.works.get(id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    const res = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Nothing on this shelf');
  });

  it('non-active status → 404', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    h.d1.works.get(id)!.status = 'removed';
    const res = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(res.status).toBe(404);
  });

  it('unknown id → 404', async () => {
    const h = makeEnv();
    const res = await dispatch(h, new Request(`${BASE}/w/AAAAAAAAAAAAAAAAAAAAAA`));
    expect(res.status).toBe(404);
  });
});

describe('chaptered reading — bake + /w/:id/:n', () => {
  it('single-chapter publish bakes exactly index.html, no ch/ objects, no TOC', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    expect(h.r2.store.has(`works/${id}/index.html`)).toBe(true);
    expect(h.r2.keysWithPrefix(`works/${id}/ch/`)).toHaveLength(0);
    expect(h.r2.store.get(`works/${id}/index.html`)).not.toContain('class="toc"');
  });

  it('3-chapter publish bakes cover + 3 chapter pages; cover has the TOC', async () => {
    const h = makeEnv();
    const { id } = await publish(h, makeBundle3());
    expect(h.r2.store.has(`works/${id}/index.html`)).toBe(true);
    expect(h.r2.keysWithPrefix(`works/${id}/ch/`).sort()).toEqual([
      `works/${id}/ch/1.html`,
      `works/${id}/ch/2.html`,
      `works/${id}/ch/3.html`,
    ]);
    const cover = h.r2.store.get(`works/${id}/index.html`) ?? '';
    expect(cover).toContain('class="toc"');
    expect(cover).not.toContain('Second chapter prose.');
    expect(h.r2.store.get(`works/${id}/ch/2.html`)).toContain('Second chapter prose.');
  });

  it('serves /w/:id/:n with cover headers but does NOT count a view; the cover does', async () => {
    const h = makeEnv();
    const { id } = await publish(h, makeBundle3());

    const ch2 = await dispatch(h, new Request(`${BASE}/w/${id}/2`));
    expect(ch2.status).toBe(200);
    expect(ch2.headers.get('content-type')).toContain('text/html');
    expect(ch2.headers.get('cache-control')).toBe('public, max-age=300');
    expect(ch2.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await ch2.text()).toContain('Second chapter prose.');
    expect(h.d1.works.get(id)?.views).toBe(0);
    expect(h.rlViews.keys).toHaveLength(0);

    const cover = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(cover.status).toBe(200);
    expect(h.d1.works.get(id)?.views).toBe(1);
  });

  it('rejects 0, leading zeros, non-numeric, and out-of-range n with a styled 404', async () => {
    const h = makeEnv();
    const { id } = await publish(h, makeBundle3());
    for (const bad of ['0', '01', '007', 'one', '1x', '1000', '4']) {
      const res = await dispatch(h, new Request(`${BASE}/w/${id}/${bad}`));
      expect(res.status, `/w/:id/${bad}`).toBe(404);
      expect(await res.text(), `/w/:id/${bad}`).toContain('Nothing on this shelf');
    }
  });

  it('chapter route gates on status and expiry exactly like the cover', async () => {
    const h = makeEnv();
    const { id } = await publish(h, makeBundle3());
    h.d1.works.get(id)!.status = 'removed';
    expect((await dispatch(h, new Request(`${BASE}/w/${id}/1`))).status).toBe(404);
    h.d1.works.get(id)!.status = 'active';
    h.d1.works.get(id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await dispatch(h, new Request(`${BASE}/w/${id}/1`))).status).toBe(404);
  });

  it('PUT shrinking 3 → 2 chapters deletes the stale ch/3 page', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h, makeBundle3());
    expect(h.r2.store.has(`works/${id}/ch/3.html`)).toBe(true);

    const two = makeBundle3();
    two.chapters = two.chapters.slice(0, 2);
    two.blocks = two.blocks.slice(0, 2);
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-manage-secret': manageSecret },
        body: JSON.stringify(two),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.r2.keysWithPrefix(`works/${id}/ch/`).sort()).toEqual([
      `works/${id}/ch/1.html`,
      `works/${id}/ch/2.html`,
    ]);
    expect((await dispatch(h, new Request(`${BASE}/w/${id}/3`))).status).toBe(404);
  });

  it('explicit multi-chapter: the age gate is baked into the cover AND every chapter page', async () => {
    const h = makeEnv();
    const { id } = await publish(h, makeBundle3({ rating: 'explicit', warnings: ['sexual-content'] }));
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('id="age-gate"');
    for (const n of [1, 2, 3]) {
      const page = h.r2.store.get(`works/${id}/ch/${n}.html`) ?? '';
      expect(page, `ch/${n}`).toContain('id="age-gate"');
      expect(page, `ch/${n}`).toContain('<main id="work" hidden>');
    }
  });

  it('admin relabel re-bakes chapter pages too', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h, makeBundle3()); // general → no gate
    expect(h.r2.store.get(`works/${id}/ch/1.html`)).not.toContain('age-gate');
    const res = await adminPost(h, `/api/admin/works/${id}/relabel`, { rating: 'explicit', warnings: [] });
    expect(res.status).toBe(200);
    expect(h.r2.store.get(`works/${id}/ch/1.html`)).toContain('id="age-gate"');
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('badge-explicit');
  });

  it('unpublish deletes the whole works/{id}/ prefix, chapter pages included', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h, makeBundle3());
    expect(h.r2.keysWithPrefix(`works/${id}/`)).toHaveLength(5); // bundle + index + 3 chapters

    const del = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, { method: 'DELETE', headers: { 'x-manage-secret': manageSecret } }),
    );
    expect(del.status).toBe(200);
    expect(h.r2.store.size).toBe(0);
    expect(h.d1.works.has(id)).toBe(false);
  });

  it('the purge cron also evaporates chapter pages', async () => {
    const h = makeEnv();
    const { id } = await publish(h, makeBundle3());
    h.d1.works.get(id)!.expires_at = new Date(Date.now() - 1000).toISOString();

    const { ctx, drain } = makeCtx();
    await worker.scheduled({} as ScheduledController, h.env, ctx);
    await drain();

    expect(h.r2.store.size).toBe(0);
    expect(h.d1.works.has(id)).toBe(false);
  });
});

describe('pages', () => {
  it('manage page ships without leaking whether the work exists', async () => {
    const h = makeEnv();
    const res = await dispatch(h, new Request(`${BASE}/w/AAAAAAAAAAAAAAAAAAAAAA/manage`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('X-Manage-Secret');
    expect(html).toContain('location.hash');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
  });

  it('landing and rules render with the CSP', async () => {
    const h = makeEnv();
    const landing = await dispatch(h, new Request(`${BASE}/`));
    const rules = await dispatch(h, new Request(`${BASE}/rules`));
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('The Shelf');
    expect(rules.status).toBe(200);
    const rulesHtml = await rules.text();
    expect(rulesHtml).toContain('id="en"');
    expect(rulesHtml).toContain('id="hu"');
    expect(rules.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('scheduled purge', () => {
  it('removes expired unlisted works (rows + R2 objects), keeps live ones', async () => {
    const h = makeEnv();
    const a = await publish(h);
    const b = await publish(h);
    h.d1.works.get(a.id)!.expires_at = new Date(Date.now() - 1000).toISOString();

    const { ctx, drain } = makeCtx();
    await worker.scheduled({} as ScheduledController, h.env, ctx);
    await drain();

    expect(h.d1.works.has(a.id)).toBe(false);
    expect(h.r2.store.has(`works/${a.id}/index.html`)).toBe(false);
    expect(h.d1.works.has(b.id)).toBe(true);
    expect(h.r2.store.has(`works/${b.id}/index.html`)).toBe(true);
  });

  it('purges removed works only after the 30-day grace window', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const fresh = await publish(h);
    const stale = await publish(h);
    await adminPost(h, `/api/admin/works/${fresh.id}/remove`, {});
    await adminPost(h, `/api/admin/works/${stale.id}/remove`, {});
    // Within grace: even an already-expired removed work survives the purge.
    h.d1.works.get(fresh.id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    h.d1.works.get(stale.id)!.removed_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    const { ctx, drain } = makeCtx();
    await worker.scheduled({} as ScheduledController, h.env, ctx);
    await drain();

    expect(h.d1.works.has(fresh.id)).toBe(true);
    expect(h.r2.store.has(`works/${fresh.id}/index.html`)).toBe(true);
    expect(h.d1.works.has(stale.id)).toBe(false);
    expect(h.r2.store.has(`works/${stale.id}/bundle.json`)).toBe(false);
  });
});

// ---------- Phase 1.5 — operator toolkit ----------

const ADMIN_SECRET = 'operator-secret-for-tests';

function adminGet(h: Harness, path: string, secret: string | null = ADMIN_SECRET): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret !== null) headers['x-admin-secret'] = secret;
  return dispatch(h, new Request(`${BASE}${path}`, { headers }));
}

function adminPost(h: Harness, path: string, body?: unknown, secret: string = ADMIN_SECRET): Promise<Response> {
  return dispatch(
    h,
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'x-admin-secret': secret, 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );
}

interface Overview {
  works: Record<string, number>;
  totalViews: number;
  recentWorks: Array<Record<string, unknown>>;
  recentReports: Array<Record<string, unknown>>;
  heldListings: Array<Record<string, unknown>>;
  publishingPaused: boolean;
  tombstones: Array<{ content_hash: string }>;
}

describe('admin auth', () => {
  it('no ADMIN_SECRET configured → 404, even with a header', async () => {
    const h = makeEnv();
    const res = await adminGet(h, '/api/admin/overview', 'anything');
    expect(res.status).toBe(404);
  });

  it('wrong secret → 404, indistinguishable from an unknown route', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const wrong = await adminGet(h, '/api/admin/overview', 'not-the-secret');
    const unknownRoute = await dispatch(h, new Request(`${BASE}/api/no-such-thing`));
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).toBe(await unknownRoute.text());
  });

  it('missing header → 404; right secret → 200', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    expect((await adminGet(h, '/api/admin/overview', null)).status).toBe(404);
    expect((await adminGet(h, '/api/admin/overview')).status).toBe(200);
  });

  it('admin routes ride the manage rate limit', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    h.rlManage.success = false;
    const res = await adminGet(h, '/api/admin/overview');
    expect(res.status).toBe(429);
  });
});

describe('GET /api/admin/overview', () => {
  it('reports counts, views, recent works, pause state', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    await dispatch(h, new Request(`${BASE}/w/${id}`)); // one open
    const res = await adminGet(h, '/api/admin/overview');
    expect(res.status).toBe(200);
    const o = (await res.json()) as Overview;
    expect(o.works['active']).toBe(1);
    expect(o.works['removed']).toBe(0);
    expect(o.totalViews).toBe(1);
    expect(o.publishingPaused).toBe(false);
    expect(o.recentWorks).toHaveLength(1);
    expect(o.recentWorks[0]?.['id']).toBe(id);
    expect(o.recentWorks[0]?.['report_count']).toBe(0);
    expect(o.tombstones).toHaveLength(0);
  });
});

describe('admin remove / restore', () => {
  it('remove → reading page 404 → restore → 200 again', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    expect((await dispatch(h, new Request(`${BASE}/w/${id}`))).status).toBe(200);

    const removed = await adminPost(h, `/api/admin/works/${id}/remove`, {});
    expect(removed.status).toBe(200);
    expect(h.d1.works.get(id)?.status).toBe('removed');
    expect(h.d1.works.get(id)?.removed_at).not.toBeNull();
    expect((await dispatch(h, new Request(`${BASE}/w/${id}`))).status).toBe(404);
    // R2 objects survive removal — restore needs them.
    expect(h.r2.store.has(`works/${id}/index.html`)).toBe(true);

    const restored = await adminPost(h, `/api/admin/works/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(h.d1.works.get(id)?.status).toBe('active');
    expect(h.d1.works.get(id)?.removed_at).toBeNull();
    expect((await dispatch(h, new Request(`${BASE}/w/${id}`))).status).toBe(200);
  });

  it('restore of a non-removed work → 409; double remove → 409', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    expect((await adminPost(h, `/api/admin/works/${id}/restore`)).status).toBe(409);
    await adminPost(h, `/api/admin/works/${id}/remove`, {});
    expect((await adminPost(h, `/api/admin/works/${id}/remove`, {})).status).toBe(409);
  });

  it('work detail returns the row without secret hashes, plus its reports', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'other', message: 'hm', website: '', ts: Date.now() - 5000 }),
      }),
    );
    const res = await adminGet(h, `/api/admin/works/${id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { work: Record<string, unknown>; reports: unknown[] };
    expect(detail.work['id']).toBe(id);
    expect(detail.work['secret_hash']).toBeUndefined();
    expect(detail.work['password_hash']).toBeUndefined();
    expect(detail.reports).toHaveLength(1);
  });
});

describe('admin relabel', () => {
  it('re-bakes the page with the new badge and updates D1; author manage GET sees it', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id, manageSecret } = await publish(h); // rating: general
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('badge-general');

    const res = await adminPost(h, `/api/admin/works/${id}/relabel`, {
      rating: 'explicit',
      warnings: ['sexual-content', 'graphic-violence'],
    });
    expect(res.status).toBe(200);

    const page = h.r2.store.get(`works/${id}/index.html`) ?? '';
    expect(page).toContain('badge-explicit');
    expect(page).toContain('Sexual content');
    expect(page).toContain('age-gate'); // explicit → gated on re-bake
    const storedBundle = JSON.parse(h.r2.store.get(`works/${id}/bundle.json`) ?? '{}') as { rating: string };
    expect(storedBundle.rating).toBe('explicit');

    const meta = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, { headers: { 'x-manage-secret': manageSecret } }),
    );
    const m = (await meta.json()) as { rating?: string; warnings: string[] };
    expect(h.d1.works.get(id)?.rating).toBe('explicit');
    expect(m.warnings).toEqual(['sexual-content', 'graphic-violence']);
  });

  it('rejects ratings and warnings outside the fixed vocabularies', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    expect((await adminPost(h, `/api/admin/works/${id}/relabel`, { rating: 'nc-17', warnings: [] })).status).toBe(400);
    expect(
      (await adminPost(h, `/api/admin/works/${id}/relabel`, { rating: 'mature', warnings: ['spiders'] })).status,
    ).toBe(400);
    expect(h.d1.works.get(id)?.rating).toBe('general');
  });
});

describe('admin expiry', () => {
  it('sets expires_at to now + days', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    const res = await adminPost(h, `/api/admin/works/${id}/expiry`, { days: 90 });
    expect(res.status).toBe(200);
    const expiresMs = Date.parse(h.d1.works.get(id)?.expires_at ?? '');
    const expected = Date.now() + 90 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresMs - expected)).toBeLessThan(60 * 1000);
  });

  it('rejects out-of-range days', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    expect((await adminPost(h, `/api/admin/works/${id}/expiry`, { days: 0 })).status).toBe(400);
    expect((await adminPost(h, `/api/admin/works/${id}/expiry`, { days: 366 })).status).toBe(400);
    expect((await adminPost(h, `/api/admin/works/${id}/expiry`, { days: 1.5 })).status).toBe(400);
  });
});

describe('tombstones', () => {
  async function publishRaw(h: Harness, bundle: PublishBundleV1): Promise<Response> {
    return await dispatch(
      h,
      new Request(`${BASE}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bundle),
      }),
    );
  }

  it('remove with tombstone blocks republish of the same content under a new title, but not different content', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);

    const res = await adminPost(h, `/api/admin/works/${id}/remove`, { tombstone: true, note: 'hard line' });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ ok: true, tombstoned: true });
    expect(h.d1.tombstones.size).toBe(1);
    const stone = [...h.d1.tombstones.values()][0];
    expect(stone?.work_title).toBe('A Quiet Book');
    expect(stone?.note).toBe('hard line');

    // Same prose, new title + pen name → still blocked, and the reason is flat.
    const disguised = await publishRaw(h, makeBundle({ title: 'Innocent New Title', pen_name: 'New Pen' }));
    expect(disguised.status).toBe(403);
    const body = (await disguised.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'not_acceptable' });

    // Different prose → publishes fine.
    const different = makeBundle();
    different.blocks[0]!.content = 'Entirely different rain falls here.';
    expect((await publishRaw(h, different)).status).toBe(200);
  });

  it('tombstone blocks the PUT update route too', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const victim = await publish(h);
    await adminPost(h, `/api/admin/works/${victim.id}/remove`, { tombstone: true });

    const other = makeBundle();
    other.blocks[0]!.content = 'A perfectly fine other book.';
    const otherRes = await dispatch(
      h,
      new Request(`${BASE}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(other),
      }),
    );
    const { id: otherId, manageSecret } = (await otherRes.json()) as { id: string; manageSecret: string };

    // Try to sneak the tombstoned text back in as an "update".
    const sneak = await dispatch(
      h,
      new Request(`${BASE}/api/works/${otherId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-manage-secret': manageSecret },
        body: JSON.stringify(makeBundle({ title: 'Laundered' })),
      }),
    );
    expect(sneak.status).toBe(403);
  });

  it('deleting a tombstone forgives the content', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    await adminPost(h, `/api/admin/works/${id}/remove`, { tombstone: true });
    const hash = [...h.d1.tombstones.keys()][0] ?? '';

    const del = await dispatch(
      h,
      new Request(`${BASE}/api/admin/tombstones/${hash}`, {
        method: 'DELETE',
        headers: { 'x-admin-secret': ADMIN_SECRET },
      }),
    );
    expect(del.status).toBe(200);
    expect(h.d1.tombstones.size).toBe(0);
    expect((await publishRaw(h, makeBundle({ title: 'Back Again' }))).status).toBe(200);
  });
});

describe('panic switch', () => {
  it('pause → publish 503 with a human message; unpause → publish works again', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    expect((await adminPost(h, '/api/admin/pause', { paused: true })).status).toBe(200);

    const blocked = await dispatch(
      h,
      new Request(`${BASE}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeBundle()),
      }),
    );
    expect(blocked.status).toBe(503);
    const body = (await blocked.json()) as { error: string; message: string };
    expect(body.error).toBe('publishing_paused');
    expect(body.message).toContain('temporarily closed');
    expect(h.d1.works.size).toBe(0);

    const overview = (await (await adminGet(h, '/api/admin/overview')).json()) as Overview;
    expect(overview.publishingPaused).toBe(true);

    expect((await adminPost(h, '/api/admin/pause', { paused: false })).status).toBe(200);
    await publish(h);
    expect(h.d1.works.size).toBe(1);
  });
});

describe('GET /w/:id/report — live report page', () => {
  it('renders the form without Turnstile when keys are unset', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    const res = await dispatch(h, new Request(`${BASE}/w/${id}/report`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="/api/works/${id}/report"`);
    expect(html).toContain('name="website"'); // honeypot
    expect(html).toContain('id="report-ts"'); // min-render-time gate
    expect(html).not.toContain('cf-turnstile');
    expect(res.headers.get('content-security-policy')).not.toContain('challenges.cloudflare.com');
  });

  it('embeds the Turnstile widget and relaxes CSP for this page only when both keys are set', async () => {
    const h = makeEnv({ TURNSTILE_SITE_KEY: 'site-key-1', TURNSTILE_SECRET_KEY: 'secret-key-1' });
    const { id } = await publish(h);
    const res = await dispatch(h, new Request(`${BASE}/w/${id}/report`));
    const html = await res.text();
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('data-sitekey="site-key-1"');
    expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('script-src \'unsafe-inline\' https://challenges.cloudflare.com');
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');

    // Other pages keep the strict CSP.
    const reading = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(reading.headers.get('content-security-policy')).not.toContain('challenges.cloudflare.com');
  });

  it('404s for an unknown or removed work', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    expect((await dispatch(h, new Request(`${BASE}/w/AAAAAAAAAAAAAAAAAAAAAA/report`))).status).toBe(404);
    const { id } = await publish(h);
    await adminPost(h, `/api/admin/works/${id}/remove`, {});
    expect((await dispatch(h, new Request(`${BASE}/w/${id}/report`))).status).toBe(404);
  });

  it('POST verifies the token against siteverify when Turnstile is on; failure → 403, nothing stored', async () => {
    const siteverify = vi.fn(async () => Response.json({ success: false }));
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('siteverify')) return await siteverify();
      return new Response('ok', { status: 200 });
    }));
    const h = makeEnv({ TURNSTILE_SITE_KEY: 'sk', TURNSTILE_SECRET_KEY: 'ss', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id } = await publish(h);

    const fields = { reason: 'other', message: 'x', website: '', ts: Date.now() - 5000 };
    const noToken = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      }),
    );
    expect(noToken.status).toBe(403);

    const badToken = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...fields, 'cf-turnstile-response': 'bad-token' }),
      }),
    );
    expect(badToken.status).toBe(403);
    expect(h.d1.reports).toHaveLength(0);

    siteverify.mockImplementation(async () => Response.json({ success: true }));
    const good = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...fields, 'cf-turnstile-response': 'good-token' }),
      }),
    );
    expect(good.status).toBe(200);
    expect(h.d1.reports).toHaveLength(1);
  });
});

describe('GET /admin — operator console page', () => {
  it('ships static, secretless, with the fragment-reading JS', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const res = await dispatch(h, new Request(`${BASE}/admin`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('X-Admin-Secret');
    expect(html).toContain('location.hash');
    expect(html).not.toContain(ADMIN_SECRET);
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
  });
});

// ---------- password tier ----------

function putPassword(h: Harness, id: string, secret: string, password: string | null): Promise<Response> {
  return dispatch(
    h,
    new Request(`${BASE}/api/works/${id}/password`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-manage-secret': secret },
      body: JSON.stringify({ password }),
    }),
  );
}

function postUnlock(h: Harness, id: string, password: string, next?: string): Promise<Response> {
  const fields: Record<string, string> = { password };
  if (next !== undefined) fields['next'] = next;
  return dispatch(
    h,
    new Request(`${BASE}/w/${id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

/** "name=value" pair from a Set-Cookie header, ready for a Cookie header. */
function cookiePair(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('PUT /api/works/:id/password', () => {
  it('stores a pbkdf2 hash (never the password) and shows up in manage meta', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    const res = await putPassword(h, id, manageSecret, 'open sesame');
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true, passwordProtected: true });

    const stored = h.d1.works.get(id)?.password_hash ?? '';
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(stored).not.toContain('open sesame');

    const meta = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, { headers: { 'x-manage-secret': manageSecret } }),
    );
    expect(((await meta.json()) as Record<string, unknown>)['passwordProtected']).toBe(true);
  });

  it('rejects out-of-range and non-string passwords; null clears', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    expect((await putPassword(h, id, manageSecret, 'abc')).status).toBe(400); // < 4
    expect((await putPassword(h, id, manageSecret, 'x'.repeat(129))).status).toBe(400);
    expect(
      (
        await dispatch(
          h,
          new Request(`${BASE}/api/works/${id}/password`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-manage-secret': manageSecret },
            body: JSON.stringify({}),
          }),
        )
      ).status,
    ).toBe(400);
    expect(h.d1.works.get(id)?.password_hash).toBeNull();

    await putPassword(h, id, manageSecret, 'valid password');
    expect(h.d1.works.get(id)?.password_hash).not.toBeNull();
    const cleared = await putPassword(h, id, manageSecret, null);
    expect(cleared.status).toBe(200);
    expect((await cleared.json()) as Record<string, unknown>).toEqual({ ok: true, passwordProtected: false });
    expect(h.d1.works.get(id)?.password_hash).toBeNull();
  });

  it('wrong secret → the same 404 as a nonexistent work', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    expect((await putPassword(h, id, 'not-the-secret', 'whatever')).status).toBe(404);
    expect(h.d1.works.get(id)?.password_hash).toBeNull();
  });
});

describe('password gate on reader routes', () => {
  it('locked cover serves the gate instead of content — and never counts a view', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    await putPassword(h, id, manageSecret, 'open sesame');

    const res = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Unlock');
    expect(html).toContain('The author shares the password personally.');
    expect(html).toContain(`action="/w/${id}/unlock"`);
    expect(html).toContain('A Quiet Book'); // title + pen name may show
    expect(html).not.toContain('Two hearts, one soul.'); // prose must not
    expect(h.d1.works.get(id)?.views).toBe(0);
    expect(h.rlViews.keys).toHaveLength(0);
  });

  it('chapter, report, and letter pages gate too, carrying next back to the page', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h, makeBundle3());
    await putPassword(h, id, manageSecret, 'open sesame');

    for (const [path, next] of [
      [`/w/${id}/2`, `/w/${id}/2`],
      [`/w/${id}/report`, `/w/${id}/report`],
      [`/w/${id}/letter`, `/w/${id}/letter`],
    ]) {
      const res = await dispatch(h, new Request(`${BASE}${path}`));
      const html = await res.text();
      expect(html, path).toContain('Unlock');
      expect(html, path).toContain(`name="next" value="${next}"`);
      expect(html, path).not.toContain('Second chapter prose.');
    }
  });

  it('the manage page stays reachable without the password', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    await putPassword(h, id, manageSecret, 'open sesame');
    const res = await dispatch(h, new Request(`${BASE}/w/${id}/manage`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Manage this work');
  });

  it('admin overview rows show password_protected', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id, manageSecret } = await publish(h);
    await putPassword(h, id, manageSecret, 'open sesame');
    const o = (await (await adminGet(h, '/api/admin/overview')).json()) as Overview;
    expect(o.recentWorks[0]?.['password_protected']).toBe(1);
  });
});

describe('POST /w/:id/unlock', () => {
  it('wrong password → gate again with a quiet error; attempt is rate-limit keyed per (ip, work)', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    await putPassword(h, id, manageSecret, 'open sesame');

    const res = await postUnlock(h, id, 'not it');
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    const html = await res.text();
    expect(html).toContain('That&#39;s not it.');
    expect(html).toContain('Unlock'); // the gate form re-serves
    expect(h.rlUnlock.keys[0]).toBe(`unknown:${id}`);
  });

  it('rate limit exhausted → 429 gate, password never checked', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    await putPassword(h, id, manageSecret, 'open sesame');
    h.rlUnlock.success = false;
    const res = await postUnlock(h, id, 'open sesame');
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('Too many tries');
  });

  it('correct password → 303 + scoped HttpOnly cookie; the cookie then unlocks cover and chapters, and views count', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h, makeBundle3());
    await putPassword(h, id, manageSecret, 'open sesame');

    const res = await postUnlock(h, id, 'open sesame');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/w/${id}`);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`shelf_u_${id}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain(`Path=/w/${id}`);
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);

    const cookie = cookiePair(res);
    const cover = await dispatch(h, new Request(`${BASE}/w/${id}`, { headers: { cookie } }));
    expect(cover.status).toBe(200);
    expect(await cover.text()).toContain('class="toc"');
    expect(cover.headers.get('cache-control')).toBe('no-store'); // locked content never shared-cached
    expect(h.d1.works.get(id)?.views).toBe(1); // unlocked cover serve counts

    const ch2 = await dispatch(h, new Request(`${BASE}/w/${id}/2`, { headers: { cookie } }));
    expect(await ch2.text()).toContain('Second chapter prose.');
    expect(h.d1.works.get(id)?.views).toBe(1); // chapters still never count
  });

  it('`next` returns the reader to a same-work path only', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h, makeBundle3());
    await putPassword(h, id, manageSecret, 'open sesame');

    const same = await postUnlock(h, id, 'open sesame', `/w/${id}/2`);
    expect(same.headers.get('location')).toBe(`/w/${id}/2`);

    for (const evil of [
      '/w/BBBBBBBBBBBBBBBBBBBBBB/1', // another work
      'https://evil.example/', // absolute URL
      `/w/${id}extra`, // prefix-confusable id
      '//evil.example/w/x',
    ]) {
      const res = await postUnlock(h, id, 'open sesame', evil);
      expect(res.headers.get('location'), evil).toBe(`/w/${id}`);
    }
  });

  it('changing the password invalidates every outstanding cookie; clearing opens the work', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    await putPassword(h, id, manageSecret, 'first password');
    const cookie = cookiePair(await postUnlock(h, id, 'first password'));

    await putPassword(h, id, manageSecret, 'second password');
    const gated = await dispatch(h, new Request(`${BASE}/w/${id}`, { headers: { cookie } }));
    expect(await gated.text()).toContain('Unlock'); // old cookie is dead

    await putPassword(h, id, manageSecret, null);
    const open = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(await open.text()).toContain('Two hearts, one soul.');
    expect(open.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('unlock on a passwordless work just redirects, no cookie; unknown work → 404', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    const res = await postUnlock(h, id, 'anything');
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await postUnlock(h, 'BBBBBBBBBBBBBBBBBBBBBB', 'x')).status).toBe(404);
  });
});

// ---------- letters to the author ----------

const TS_OK = (): string => String(Date.now() - 5000);

function formLetter(h: Harness, id: string, fields: Record<string, string>): Promise<Response> {
  return dispatch(
    h,
    new Request(`${BASE}/api/works/${id}/letters`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

function jsonLetter(h: Harness, id: string, fields: Record<string, unknown>): Promise<Response> {
  return dispatch(
    h,
    new Request(`${BASE}/api/works/${id}/letters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  );
}

describe('POST /api/works/:id/letters', () => {
  it('form happy path: stored in D1 with a 22-char id, styled confirmation, NO Discord forward', async () => {
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id } = await publish(h);
    const res = await formLetter(h, id, {
      body: 'Your dialogue sings. Chapter two broke me.',
      contact: 'bird@example.com',
      website: '',
      ts: TS_OK(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('on its way to the author');

    expect(h.d1.letters).toHaveLength(1);
    expect(h.d1.letters[0]?.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(h.d1.letters[0]?.work_id).toBe(id);
    expect(h.d1.letters[0]?.body).toBe('Your dialogue sings. Chapter two broke me.');
    expect(h.d1.letters[0]?.contact).toBe('bird@example.com');
    // Letters are the author's, not the operator's — Discord never rings.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('JSON post gets a JSON response and the letter rides the RL_LETTER limit', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    const res = await jsonLetter(h, id, { body: 'Hello', contact: '', website: '', ts: Date.now() - 5000 });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    expect(h.d1.letters).toHaveLength(1);
    expect(h.rlLetter.keys).toHaveLength(1);

    h.rlLetter.success = false;
    expect((await jsonLetter(h, id, { body: 'again', ts: Date.now() - 5000 })).status).toBe(429);
  });

  it('honeypot filled or too-fast submit → accepted but NOT stored', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    const hp = await formLetter(h, id, { body: 'spam', website: 'https://spam.example', ts: TS_OK() });
    expect(hp.status).toBe(200);
    expect(await hp.text()).toContain('on its way');
    const fast = await formLetter(h, id, { body: 'bot', website: '', ts: String(Date.now()) });
    expect(fast.status).toBe(200);
    expect(h.d1.letters).toHaveLength(0);
  });

  it('enforces the body/contact caps and rejects empty letters', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    expect((await jsonLetter(h, id, { body: 'x'.repeat(4001), ts: Date.now() - 5000 })).status).toBe(400);
    expect((await jsonLetter(h, id, { body: 'ok', contact: 'x'.repeat(201), ts: Date.now() - 5000 })).status).toBe(400);
    expect((await jsonLetter(h, id, { body: '   ', ts: Date.now() - 5000 })).status).toBe(400);
    expect(h.d1.letters).toHaveLength(0);
    // At the cap is fine.
    expect((await jsonLetter(h, id, { body: 'x'.repeat(4000), contact: 'y'.repeat(200), ts: Date.now() - 5000 })).status).toBe(200);
    expect(h.d1.letters).toHaveLength(1);
  });

  it('letters_open = 0 → the exact 404 an unknown work produces, on page AND endpoint', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);

    const close = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/letters-open`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-manage-secret': manageSecret },
        body: JSON.stringify({ open: false }),
      }),
    );
    expect(close.status).toBe(200);
    expect(h.d1.works.get(id)?.letters_open).toBe(0);

    const page = await dispatch(h, new Request(`${BASE}/w/${id}/letter`));
    expect(page.status).toBe(404);
    expect(await page.text()).toContain('Nothing on this shelf'); // not "letters are closed"

    const postJson = await jsonLetter(h, id, { body: 'anyone home?', ts: Date.now() - 5000 });
    expect(postJson.status).toBe(404);
    expect((await postJson.json()) as Record<string, unknown>).toEqual({ error: 'not_found' });
    expect(h.d1.letters).toHaveLength(0);

    // Reopen → the page serves the form again.
    await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/letters-open`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-manage-secret': manageSecret },
        body: JSON.stringify({ open: true }),
      }),
    );
    expect((await dispatch(h, new Request(`${BASE}/w/${id}/letter`))).status).toBe(200);
  });

  it('per-work cap: the 502nd letter evicts the oldest two', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    for (let i = 0; i < 502; i++) {
      const res = await jsonLetter(h, id, { body: `letter ${i}`, ts: Date.now() - 5000 });
      expect(res.status).toBe(200);
    }
    expect(h.d1.letters).toHaveLength(500);
    const bodies = h.d1.letters.map((l) => l.body);
    expect(bodies).not.toContain('letter 0');
    expect(bodies).not.toContain('letter 1');
    expect(bodies[0]).toBe('letter 2');
    expect(bodies[499]).toBe('letter 501');
  });

  it('Turnstile configured → letter POST without a valid token → 403, nothing stored', async () => {
    const h = makeEnv({ TURNSTILE_SITE_KEY: 'sk', TURNSTILE_SECRET_KEY: 'ss' });
    const { id } = await publish(h);
    const res = await jsonLetter(h, id, { body: 'no token', ts: Date.now() - 5000 });
    expect(res.status).toBe(403);
    expect(h.d1.letters).toHaveLength(0);
  });
});

describe('GET /w/:id/letter — live letter page', () => {
  it('renders the form with caps, honeypot, and render-time gate', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    const res = await dispatch(h, new Request(`${BASE}/w/${id}/letter`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="/api/works/${id}/letters"`);
    expect(html).toContain('name="body"');
    expect(html).toContain('maxlength="4000"');
    expect(html).toContain('name="contact"');
    expect(html).toContain('maxlength="200"');
    expect(html).toContain('name="website"'); // honeypot
    expect(html).toContain('id="letter-ts"'); // min-render-time gate
    expect(html).not.toContain('cf-turnstile');
  });

  it('embeds Turnstile and relaxes CSP for this page only when both keys are set', async () => {
    const h = makeEnv({ TURNSTILE_SITE_KEY: 'site-key-1', TURNSTILE_SECRET_KEY: 'secret-key-1' });
    const { id } = await publish(h);
    const res = await dispatch(h, new Request(`${BASE}/w/${id}/letter`));
    const html = await res.text();
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('data-sitekey="site-key-1"');
    expect(res.headers.get('content-security-policy')).toContain('challenges.cloudflare.com');
  });

  it('404s for an unknown or removed work', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    expect((await dispatch(h, new Request(`${BASE}/w/AAAAAAAAAAAAAAAAAAAAAA/letter`))).status).toBe(404);
    const { id } = await publish(h);
    await adminPost(h, `/api/admin/works/${id}/remove`, {});
    expect((await dispatch(h, new Request(`${BASE}/w/${id}/letter`))).status).toBe(404);
  });
});

describe('author inbox — GET/DELETE /api/works/:id/letters', () => {
  it('requires the manage secret; wrong secret → 404', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    await jsonLetter(h, id, { body: 'private mail', ts: Date.now() - 5000 });

    const noSecret = await dispatch(h, new Request(`${BASE}/api/works/${id}/letters`));
    expect(noSecret.status).toBe(404);
    const wrong = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/letters`, { headers: { 'x-manage-secret': 'nope' } }),
    );
    expect(wrong.status).toBe(404);
  });

  it('returns lettersOpen + letters newest first', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    await jsonLetter(h, id, { body: 'first letter', contact: '', ts: Date.now() - 5000 });
    await jsonLetter(h, id, { body: 'second letter', contact: 'me@example.com', ts: Date.now() - 5000 });

    const res = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/letters`, { headers: { 'x-manage-secret': manageSecret } }),
    );
    expect(res.status).toBe(200);
    const inbox = (await res.json()) as {
      lettersOpen: boolean;
      letters: Array<{ id: string; body: string; contact: string; created_at: string }>;
    };
    expect(inbox.lettersOpen).toBe(true);
    expect(inbox.letters).toHaveLength(2);
    expect(inbox.letters[0]?.body).toBe('second letter'); // newest first
    expect(inbox.letters[1]?.body).toBe('first letter');
    expect(inbox.letters[0]).not.toHaveProperty('work_id');
  });

  it('DELETE removes one letter with the secret; wrong secret leaves it', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    await jsonLetter(h, id, { body: 'keep me', ts: Date.now() - 5000 });
    await jsonLetter(h, id, { body: 'delete me', ts: Date.now() - 5000 });
    const target = h.d1.letters.find((l) => l.body === 'delete me');
    expect(target).toBeDefined();

    const wrong = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/letters/${target?.id}`, {
        method: 'DELETE',
        headers: { 'x-manage-secret': 'nope' },
      }),
    );
    expect(wrong.status).toBe(404);
    expect(h.d1.letters).toHaveLength(2);

    const del = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}/letters/${target?.id}`, {
        method: 'DELETE',
        headers: { 'x-manage-secret': manageSecret },
      }),
    );
    expect(del.status).toBe(200);
    expect(h.d1.letters).toHaveLength(1);
    expect(h.d1.letters[0]?.body).toBe('keep me');
  });

  it("unpublish cascades: the work's letters evaporate with it", async () => {
    const h = makeEnv();
    const a = await publish(h);
    const b = await publish(h);
    await jsonLetter(h, a.id, { body: 'to the leaving author', ts: Date.now() - 5000 });
    await jsonLetter(h, b.id, { body: 'to the staying author', ts: Date.now() - 5000 });

    const del = await dispatch(
      h,
      new Request(`${BASE}/api/works/${a.id}`, { method: 'DELETE', headers: { 'x-manage-secret': a.manageSecret } }),
    );
    expect(del.status).toBe(200);
    expect(h.d1.letters).toHaveLength(1);
    expect(h.d1.letters[0]?.work_id).toBe(b.id);
  });

  it('baked pages link to the letter page in the footer', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain(`href="/w/${id}/letter"`);
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('Write to the author');
  });
});

// ---------- Phase 2 moderation chain (SHADOW MODE) ----------

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function anthropicToolUse(name: string, input: unknown): Response {
  return Response.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function toolChoiceName(c: CapturedCall): unknown {
  return (c.body?.['tool_choice'] as Record<string, unknown> | undefined)?.['name'];
}

function userMessageText(body: Record<string, unknown> | null): string {
  const messages = body?.['messages'];
  if (!Array.isArray(messages)) return '';
  const first = messages[0] as Record<string, unknown> | undefined;
  return typeof first?.['content'] === 'string' ? first['content'] : '';
}

/**
 * Stubs globalThis.fetch with a dispatcher that answers api.anthropic.com
 * with canned forced-tool-use replies and everything else (Discord) with 200.
 * The real API is never touched in tests.
 */
function stubModerationFetch(opts: {
  /** Per-chunk router flags; default = no flags anywhere. */
  routerFlags?: (chunkNo: number, messageText: string) => string[];
  /** Canned verify_work tool input. */
  verifier?: unknown;
  /** Force every anthropic call to this HTTP status (error-path tests). */
  anthropicStatus?: number;
  /** Runs on every anthropic call (e.g. simulate unpublish mid-run). */
  onAnthropic?: () => void;
}): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });

      if (url.startsWith('https://api.anthropic.com')) {
        opts.onAnthropic?.();
        if (opts.anthropicStatus !== undefined) {
          return new Response('{"type":"error"}', { status: opts.anthropicStatus });
        }
        const tool = toolChoiceName({ url, headers: {}, body });
        if (tool === 'route_chunks') {
          const text = userMessageText(body);
          const nums = [...text.matchAll(/--- CHUNK (\d+) ---/g)].map((m) => Number(m[1]));
          return anthropicToolUse('route_chunks', {
            results: nums.map((n) => ({ chunk: n, flags: opts.routerFlags?.(n, text) ?? [] })),
          });
        }
        if (tool === 'verify_work') {
          return anthropicToolUse(
            'verify_work',
            opts.verifier ?? {
              hardLine: 'none',
              reason: '',
              labels: 'honest',
              suggested: { rating: 'general', warnings: [] },
            },
          );
        }
        return new Response('{"type":"error"}', { status: 500 });
      }
      return new Response('ok', { status: 200 });
    }),
  );
  return { calls };
}

const anthropicCalls = (calls: CapturedCall[]): CapturedCall[] =>
  calls.filter((c) => c.url.startsWith('https://api.anthropic.com'));
const discordCalls = (calls: CapturedCall[]): CapturedCall[] =>
  calls.filter((c) => c.url.includes('discord'));

/** A bundle big enough (>200 chars of prose) to enter the chain. */
function makeModeratedBundle(prose?: string): PublishBundleV1 {
  const content =
    prose ?? 'The rain kept its own counsel over the rooftops of the sleeping town. '.repeat(6);
  return makeBundle({
    blocks: [
      { id: 'b1', chapter_id: 'ch1', type: 'text', content, order: 0, metadata: { type: 'text' } },
    ],
  });
}

function storedVerdict(h: Harness, id: string): Record<string, unknown> | null {
  const raw = h.d1.works.get(id)?.moderation_verdict ?? null;
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

describe('moderation chain (shadow mode)', () => {
  it('without ANTHROPIC_API_KEY the chain is a complete no-op: no calls, no verdict', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id } = await publish(h, makeModeratedBundle());
    expect(calls).toHaveLength(0);
    const row = h.d1.works.get(id);
    expect(row?.moderation_verdict).toBeNull();
    expect(row?.moderation_at).toBeNull();
  });

  it('tiny work (<200 chars) is skipped: no calls, no verdict', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id } = await publish(h); // default bundle: ~40 chars of prose
    expect(anthropicCalls(calls)).toHaveLength(0);
    expect(h.d1.works.get(id)?.moderation_verdict).toBeNull();
  });

  it('happy pass: router-only run, verdict stored, no Discord noise', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id } = await publish(h, makeModeratedBundle());

    const verdict = storedVerdict(h, id);
    expect(verdict?.['outcome']).toBe('pass');
    expect(verdict?.['truncated']).toBe(false);
    expect(verdict?.['flaggedChunks']).toBe(0);
    expect(typeof verdict?.['ms']).toBe('number');
    expect(h.d1.works.get(id)?.moderation_at).toBeTruthy();

    const api = anthropicCalls(calls);
    expect(api.length).toBeGreaterThan(0);
    // Every call is the cheap router — no verifier spend on a clean work.
    expect(api.every((c) => toolChoiceName(c) === 'route_chunks')).toBe(true);
    expect(api[0]?.headers['x-api-key']).toBe('sk-test');
    expect(api[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(api[0]?.body?.['model']).toBe('claude-haiku-4-5');
    expect(discordCalls(calls)).toHaveLength(0);
  });

  it('under-labeled → tag-fix verdict + Discord embed + suggestion in the admin surface', async () => {
    const { calls } = stubModerationFetch({
      routerFlags: () => ['sexual-explicit'],
      verifier: {
        hardLine: 'none',
        reason: 'the excerpt is explicit: "against the harbor wall"',
        labels: 'under-labeled',
        suggested: { rating: 'explicit', warnings: ['sexual-content'] },
      },
    });
    const h = makeEnv({
      ANTHROPIC_API_KEY: 'sk-test',
      DISCORD_WEBHOOK: 'https://discord.example/hook',
      ADMIN_SECRET,
    });
    const { id } = await publish(h, makeModeratedBundle());

    const verdict = storedVerdict(h, id);
    expect(verdict?.['outcome']).toBe('tag-fix');
    expect(verdict?.['suggested']).toEqual({ rating: 'explicit', warnings: ['sexual-content'] });

    const api = anthropicCalls(calls);
    expect(api.some((c) => toolChoiceName(c) === 'verify_work')).toBe(true);
    expect(api.find((c) => toolChoiceName(c) === 'verify_work')?.body?.['model']).toBe('claude-sonnet-5');

    const discord = discordCalls(calls);
    expect(discord).toHaveLength(1);
    const payload = JSON.stringify(discord[0]?.body);
    expect(payload).toContain('tag-fix');
    expect(payload).toContain('SHADOW MODE');
    expect(payload).toContain('explicit');

    // Admin overview row carries the outcome…
    const overview = await adminGet(h, '/api/admin/overview');
    const o = (await overview.json()) as { recentWorks: { id: string; moderation_outcome: string | null }[] };
    expect(o.recentWorks.find((w) => w.id === id)?.moderation_outcome).toBe('tag-fix');

    // …and the detail carries the parsed verdict with the suggestion.
    const detail = await adminGet(h, `/api/admin/works/${id}`);
    expect(detail.status).toBe(200);
    const d = (await detail.json()) as {
      work: { moderation: { outcome: string; suggested?: { rating: string; warnings: string[] } } | null };
    };
    expect(d.work.moderation?.outcome).toBe('tag-fix');
    expect(d.work.moderation?.suggested?.rating).toBe('explicit');
    expect(d.work.moderation?.suggested?.warnings).toEqual(['sexual-content']);
  });

  it('hard-line flag → hold verdict + Discord ping (and nothing blocked)', async () => {
    const { calls } = stubModerationFetch({
      routerFlags: () => ['minors'],
      verifier: {
        hardLine: 'minors',
        reason: 'the quoted scene sexualizes a character stated to be 12',
        labels: 'honest',
        suggested: { rating: 'general', warnings: [] },
      },
    });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id } = await publish(h, makeModeratedBundle());

    const verdict = storedVerdict(h, id);
    expect(verdict?.['outcome']).toBe('hold');
    expect(verdict?.['reason']).toContain('12');

    const discord = discordCalls(calls);
    expect(discord).toHaveLength(1);
    expect(JSON.stringify(discord[0]?.body)).toContain('hold');
    expect(JSON.stringify(discord[0]?.body)).toContain('SHADOW MODE');

    // Shadow mode: the work is still fully published and readable.
    expect(h.d1.works.get(id)?.status).toBe('active');
    expect(h.r2.store.has(`works/${id}/index.html`)).toBe(true);
  });

  it('API 500 → error verdict stored; the publish response is untouched', async () => {
    stubModerationFetch({ anthropicStatus: 500 });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const out = await publish(h, makeModeratedBundle()); // asserts 200 inside
    expect(out.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(out.manageSecret.length).toBeGreaterThanOrEqual(43);

    const verdict = storedVerdict(h, out.id);
    expect(verdict?.['outcome']).toBe('error');
    expect(String(verdict?.['reason'])).toContain('500');
  });

  it('unpublish mid-run: verdict write no-ops silently, nothing throws', async () => {
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    stubModerationFetch({ onAnthropic: () => h.d1.works.clear() });
    // dispatch() drains waitUntil — resolving at all is the "doesn't throw".
    const { id } = await publish(h, makeModeratedBundle());
    expect(h.d1.works.has(id)).toBe(false);
  });

  it('manage update (PUT) re-runs the chain on the new text', async () => {
    const { calls } = stubModerationFetch({
      routerFlags: (_n, text) => (text.includes('unlabeled-heat') ? ['sexual-explicit'] : []),
      verifier: {
        hardLine: 'none',
        reason: '',
        labels: 'under-labeled',
        suggested: { rating: 'mature', warnings: ['sexual-content'] },
      },
    });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    expect(storedVerdict(h, id)?.['outcome']).toBe('pass');
    const callsAfterPublish = anthropicCalls(calls).length;

    const updated = makeModeratedBundle(
      'And then, unlabeled-heat, the chapter turned explicit without a warning tag. '.repeat(5),
    );
    const res = await dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-manage-secret': manageSecret },
        body: JSON.stringify(updated),
      }),
    );
    expect(res.status).toBe(200);
    expect(anthropicCalls(calls).length).toBeGreaterThan(callsAfterPublish);
    expect(storedVerdict(h, id)?.['outcome']).toBe('tag-fix');
  });

  it('the publish HTTP response is identical in shape with and without the key configured', async () => {
    stubModerationFetch({});
    const bare = makeEnv();
    const keyed = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const post = (): Request =>
      new Request(`${BASE}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeModeratedBundle()),
      });

    const r1 = await dispatch(bare, post());
    const r2 = await dispatch(keyed, post());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const b1 = (await r1.json()) as Record<string, unknown>;
    const b2 = (await r2.json()) as Record<string, unknown>;
    expect(Object.keys(b1).sort()).toEqual(Object.keys(b2).sort());
    for (const b of [b1, b2]) {
      expect(String(b['id'])).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(String(b['url'])).toBe(`${BASE}/w/${String(b['id'])}`);
      expect(String(b['manageSecret']).length).toBeGreaterThanOrEqual(43);
    }
  });
});

// ---------- Phase 3 — listing lifecycle + the gate ----------

function putListing(h: Harness, id: string, secret: string, list: boolean): Promise<Response> {
  return dispatch(
    h,
    new Request(`${BASE}/api/works/${id}/listing`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-manage-secret': secret },
      body: JSON.stringify({ list }),
    }),
  );
}

function putLabels(h: Harness, id: string, secret: string, rating: string, warnings: string[]): Promise<Response> {
  return dispatch(
    h,
    new Request(`${BASE}/api/works/${id}/labels`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-manage-secret': secret },
      body: JSON.stringify({ rating, warnings }),
    }),
  );
}

function getMeta(h: Harness, id: string, secret: string): Promise<Response> {
  return dispatch(h, new Request(`${BASE}/api/works/${id}`, { headers: { 'x-manage-secret': secret } }));
}

/** Put a work straight onto the shelf, bypassing the gate (test setup only). */
function forceList(h: Harness, id: string, listedAt: string): void {
  const row = h.d1.works.get(id);
  if (!row) throw new Error(`forceList: no such work ${id}`);
  row.listed = 1;
  row.listing_state = 'listed';
  row.listed_at = listedAt;
}

function listingVerdictOf(h: Harness, id: string): Record<string, unknown> | null {
  const raw = h.d1.works.get(id)?.listing_verdict ?? null;
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

describe('PUT /api/works/:id/listing — the gate', () => {
  it('happy path with key: pending → chain pass → listed + listed_at + Discord info embed', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    // Pre-0006 row (NULL hash): the gate must run the chain fresh — the
    // verdict-reuse path has its own coverage in the budget-guard suite.
    h.d1.works.get(id)!.content_hash = null;

    const res = await putListing(h, id, manageSecret, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['listingState']).toBe('pending');

    // dispatch() drained the waitUntil — the gate has resolved by now.
    const row = h.d1.works.get(id);
    expect(row?.listing_state).toBe('listed');
    expect(row?.listed).toBe(1);
    expect(typeof row?.listed_at).toBe('string');
    expect(row?.listing_verdict).toBeNull();

    const discord = discordCalls(calls);
    expect(discord).toHaveLength(1);
    const payload = JSON.stringify(discord[0]?.body);
    expect(payload).toContain('Listed on the Shelf');
    expect(payload).toContain(id);
    expect(payload).toContain('general'); // rating travels in the info embed
  });

  it('tag-fix → refused with author-facing suggested labels; NO Discord; meta surfaces the verdict', async () => {
    const { calls } = stubModerationFetch({
      routerFlags: () => ['sexual-explicit'],
      verifier: {
        hardLine: 'none',
        reason: 'explicit content without labels',
        labels: 'under-labeled',
        suggested: { rating: 'explicit', warnings: ['sexual-content'] },
      },
    });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    // Pre-0006 row (NULL hash) → fresh chain run, not verdict reuse.
    h.d1.works.get(id)!.content_hash = null;
    // The shadow run on publish already pinged Discord once — count from here.
    const discordBefore = discordCalls(calls).length;

    await putListing(h, id, manageSecret, true);

    const row = h.d1.works.get(id);
    expect(row?.listing_state).toBe('refused');
    expect(row?.listed).toBe(0);
    expect(listingVerdictOf(h, id)).toEqual({
      reason: 'labels',
      suggested: { rating: 'explicit', warnings: ['sexual-content'] },
    });
    // tag-fix is the author's fix to make — no operator ping.
    expect(discordCalls(calls).length).toBe(discordBefore);

    const meta = (await (await getMeta(h, id, manageSecret)).json()) as Record<string, unknown>;
    expect(meta['listingState']).toBe('refused');
    expect(meta['listingVerdict']).toEqual({
      reason: 'labels',
      suggested: { rating: 'explicit', warnings: ['sexual-content'] },
    });
  });

  it('accept-labels flow: PUT labels re-bakes, then a re-request passes and lists', async () => {
    // Router always flags sexual-explicit; once the rating is explicit the
    // flags are covered, so no verifier call is needed and the chain passes.
    const { calls } = stubModerationFetch({
      routerFlags: () => ['sexual-explicit'],
      verifier: {
        hardLine: 'none',
        reason: 'explicit content without labels',
        labels: 'under-labeled',
        suggested: { rating: 'explicit', warnings: ['sexual-content'] },
      },
    });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());

    await putListing(h, id, manageSecret, true);
    expect(h.d1.works.get(id)?.listing_state).toBe('refused');
    const suggested = listingVerdictOf(h, id)?.['suggested'] as { rating: string; warnings: string[] };

    // The manage page's accept button: PUT labels, then re-request.
    const relabel = await putLabels(h, id, manageSecret, suggested.rating, suggested.warnings);
    expect(relabel.status).toBe(200);
    expect(h.d1.works.get(id)?.rating).toBe('explicit');
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('badge-explicit');
    const storedBundle = JSON.parse(h.r2.store.get(`works/${id}/bundle.json`) ?? '{}') as { rating: string };
    expect(storedBundle.rating).toBe('explicit');

    // Verifier calls so far: the shadow run at publish + the refusing gate run.
    const verifierCallsBefore = anthropicCalls(calls).filter((c) => toolChoiceName(c) === 'verify_work').length;

    const retry = await putListing(h, id, manageSecret, true);
    expect(retry.status).toBe(200);
    expect(h.d1.works.get(id)?.listing_state).toBe('listed');
    expect(h.d1.works.get(id)?.listed).toBe(1);
    // The second gate run went router-only: labels now cover the flags.
    const verifierCallsAfter = anthropicCalls(calls).filter((c) => toolChoiceName(c) === 'verify_work').length;
    expect(verifierCallsAfter).toBe(verifierCallsBefore);
  });

  it('hard-line hold → held with reason review + Discord "needs your decision"; work stays readable', async () => {
    const { calls } = stubModerationFetch({
      routerFlags: () => ['minors'],
      verifier: {
        hardLine: 'minors',
        reason: 'the quoted scene involves a minor',
        labels: 'honest',
        suggested: { rating: 'general', warnings: [] },
      },
    });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    // Pre-0006 row (NULL hash) → fresh chain run, not verdict reuse.
    h.d1.works.get(id)!.content_hash = null;
    const discordBefore = discordCalls(calls).length;

    await putListing(h, id, manageSecret, true);

    expect(h.d1.works.get(id)?.listing_state).toBe('held');
    expect(h.d1.works.get(id)?.listed).toBe(0);
    expect(listingVerdictOf(h, id)).toEqual({ reason: 'review' });

    const discord = discordCalls(calls).slice(discordBefore);
    expect(discord).toHaveLength(1);
    const payload = JSON.stringify(discord[0]?.body);
    expect(payload).toContain('LISTING HELD');
    expect(payload).toContain('needs your decision');
    expect(payload).toContain('the quoted scene involves a minor');

    // Held ≠ removed: the reading link still works, the work is just not listed.
    expect((await dispatch(h, new Request(`${BASE}/w/${id}`))).status).toBe(200);
  });

  it('chain error → held with reason error + Discord (a broken chain never lists)', async () => {
    stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    // Stale the stored pass verdict (pre-0006 NULL hash) so the gate must
    // run the chain — which is about to break.
    h.d1.works.get(id)!.content_hash = null;

    const { calls } = stubModerationFetch({ anthropicStatus: 500 });
    await putListing(h, id, manageSecret, true);

    expect(h.d1.works.get(id)?.listing_state).toBe('held');
    expect(h.d1.works.get(id)?.listed).toBe(0);
    expect(listingVerdictOf(h, id)).toEqual({ reason: 'error' });
    const payload = JSON.stringify(discordCalls(calls).map((c) => c.body));
    expect(payload).toContain('chain error');
  });

  it('no ANTHROPIC_API_KEY → held with reason manual + Discord "manual review" (documented fallback)', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id, manageSecret } = await publish(h);

    const res = await putListing(h, id, manageSecret, true);
    expect(res.status).toBe(200);
    expect(h.d1.works.get(id)?.listing_state).toBe('held');
    expect(h.d1.works.get(id)?.listed).toBe(0);
    expect(listingVerdictOf(h, id)).toEqual({ reason: 'manual' });

    expect(anthropicCalls(calls)).toHaveLength(0);
    const discord = discordCalls(calls);
    expect(discord).toHaveLength(1);
    expect(JSON.stringify(discord[0]?.body)).toContain('LISTING REQUEST');
    expect(JSON.stringify(discord[0]?.body)).toContain('manual review');
  });

  it('password-locked work → 409 password_locked, state untouched', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    await putPassword(h, id, manageSecret, 'open sesame');

    const res = await putListing(h, id, manageSecret, true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)['error']).toBe('password_locked');
    expect(h.d1.works.get(id)?.listing_state).toBeNull();
    expect(h.d1.works.get(id)?.listed).toBe(0);
  });

  it('delist always works: from listed, and as a withdrawal while held', async () => {
    const h = makeEnv(); // no key → held
    const { id, manageSecret } = await publish(h);

    await putListing(h, id, manageSecret, true);
    expect(h.d1.works.get(id)?.listing_state).toBe('held');
    const withdrawn = await putListing(h, id, manageSecret, false);
    expect(withdrawn.status).toBe(200);
    expect(h.d1.works.get(id)?.listing_state).toBeNull();
    expect(listingVerdictOf(h, id)).toBeNull();

    forceList(h, id, new Date().toISOString());
    const delisted = await putListing(h, id, manageSecret, false);
    expect(delisted.status).toBe(200);
    const row = h.d1.works.get(id);
    expect(row?.listed).toBe(0);
    expect(row?.listing_state).toBeNull();
    expect(row?.listed_at).toBeNull();
  });

  it('re-requesting while held is a no-op: no second gate run, no Discord spam', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id, manageSecret } = await publish(h);

    await putListing(h, id, manageSecret, true);
    expect(discordCalls(calls)).toHaveLength(1);

    const again = await putListing(h, id, manageSecret, true);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Record<string, unknown>)['listingState']).toBe('held');
    expect(discordCalls(calls)).toHaveLength(1); // still just the first ping
  });

  it('wrong secret → the same 404 on listing and labels routes', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    expect((await putListing(h, id, 'not-the-secret', true)).status).toBe(404);
    expect((await putLabels(h, id, 'not-the-secret', 'mature', [])).status).toBe(404);
    expect(h.d1.works.get(id)?.listing_state).toBeNull();
    expect(h.d1.works.get(id)?.rating).toBe('general');
  });

  it('author delists mid-gate-run: the slow chain must not list against their will', async () => {
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    // Simulate a withdrawal landing while the chain is mid-flight.
    const { calls } = stubModerationFetch({
      onAnthropic: () => {
        const row = h.d1.works.get(id);
        if (row) {
          row.listing_state = null;
          row.listed = 0;
        }
      },
    });
    const discordBefore = discordCalls(calls).length;
    await putListing(h, id, manageSecret, true);

    const row = h.d1.works.get(id);
    expect(row?.listing_state).toBeNull();
    expect(row?.listed).toBe(0);
    expect(discordCalls(calls).length).toBe(discordBefore); // skipped write = skipped ping
  });
});

describe('PUT /api/works/:id/labels — author relabel', () => {
  it('validates the fixed vocabularies', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h);
    expect((await putLabels(h, id, manageSecret, 'nc-17', [])).status).toBe(400);
    expect((await putLabels(h, id, manageSecret, 'mature', ['spiders'])).status).toBe(400);
    expect(h.d1.works.get(id)?.rating).toBe('general');
  });

  it('re-bakes every page with the new labels', async () => {
    const h = makeEnv();
    const { id, manageSecret } = await publish(h, makeBundle3());
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('badge-general');

    const res = await putLabels(h, id, manageSecret, 'explicit', ['sexual-content']);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      rating: 'explicit',
      warnings: ['sexual-content'],
    });
    expect(h.d1.works.get(id)?.rating).toBe('explicit');
    expect(h.r2.store.get(`works/${id}/index.html`)).toContain('badge-explicit');
    expect(h.r2.store.get(`works/${id}/ch/1.html`)).toContain('id="age-gate"'); // chapters re-baked too
  });
});

describe('POST /api/admin/works/:id/listing — operator decision', () => {
  it('approve on a manual hold → listed exactly like a chain pass', async () => {
    const h = makeEnv({ ADMIN_SECRET }); // no key → manual hold
    const { id, manageSecret } = await publish(h);
    await putListing(h, id, manageSecret, true);
    expect(h.d1.works.get(id)?.listing_state).toBe('held');

    const res = await adminPost(h, `/api/admin/works/${id}/listing`, { action: 'approve' });
    expect(res.status).toBe(200);
    const row = h.d1.works.get(id);
    expect(row?.listing_state).toBe('listed');
    expect(row?.listed).toBe(1);
    expect(typeof row?.listed_at).toBe('string');
    expect(row?.listing_verdict).toBeNull();
  });

  it('deny → refused with reason operator, visible in the author meta', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id, manageSecret } = await publish(h);
    await putListing(h, id, manageSecret, true);

    const res = await adminPost(h, `/api/admin/works/${id}/listing`, { action: 'deny' });
    expect(res.status).toBe(200);
    expect(h.d1.works.get(id)?.listing_state).toBe('refused');
    expect(h.d1.works.get(id)?.listed).toBe(0);
    expect(listingVerdictOf(h, id)).toEqual({ reason: 'operator' });

    const meta = (await (await getMeta(h, id, manageSecret)).json()) as Record<string, unknown>;
    expect(meta['listingState']).toBe('refused');
    expect(meta['listingVerdict']).toEqual({ reason: 'operator' });
  });

  it('rejects bad actions and decisions on works with no pending/held request', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    expect((await adminPost(h, `/api/admin/works/${id}/listing`, { action: 'shrug' })).status).toBe(400);
    expect((await adminPost(h, `/api/admin/works/${id}/listing`, { action: 'approve' })).status).toBe(409);
    forceList(h, id, new Date().toISOString());
    expect((await adminPost(h, `/api/admin/works/${id}/listing`, { action: 'deny' })).status).toBe(409);
  });

  it('overview surfaces held listings as the Needs-decision queue, and listing_state on rows', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const held = await publish(h);
    const plain = await publish(h);
    await putListing(h, held.id, held.manageSecret, true); // no key → held/manual

    const o = (await (await adminGet(h, '/api/admin/overview')).json()) as Overview;
    expect(o.heldListings).toHaveLength(1);
    expect(o.heldListings[0]?.['id']).toBe(held.id);
    expect(o.heldListings[0]?.['listing']).toEqual({ reason: 'manual' });
    expect(o.heldListings[0]?.['listing_verdict']).toBeUndefined(); // raw JSON never leaves

    const rows = new Map(o.recentWorks.map((w) => [w['id'], w]));
    expect(rows.get(held.id)?.['listing_state']).toBe('held');
    expect(rows.get(plain.id)?.['listing_state']).toBeNull();
  });

  it('admin remove delists a listed work', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const { id } = await publish(h);
    forceList(h, id, new Date().toISOString());

    const res = await adminPost(h, `/api/admin/works/${id}/remove`, {});
    expect(res.status).toBe(200);
    const row = h.d1.works.get(id);
    expect(row?.status).toBe('removed');
    expect(row?.listed).toBe(0);
    expect(row?.listing_state).toBeNull();
    expect(row?.listed_at).toBeNull();
  });
});

// ---------- Phase 3 — GET /shelf ----------

/** Publish n works and force-list them with strictly increasing listed_at. */
async function publishListed(
  h: Harness,
  n: number,
  mutate?: (bundle: PublishBundleV1, i: number) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const bundle = makeBundle({ title: `Listed Work ${i}` });
    mutate?.(bundle, i);
    const { id } = await publish(h, bundle);
    forceList(h, id, new Date(Date.UTC(2026, 0, 1 + i)).toISOString());
    ids.push(id);
  }
  return ids;
}

describe('GET /shelf', () => {
  it('shows only listed+active works — refused/held/pending/unlisted/removed never appear', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const listed = await publish(h, makeBundle({ title: 'The Visible One' }));
    forceList(h, listed.id, new Date().toISOString());

    const unlisted = await publish(h, makeBundle({ title: 'Merely Linked' }));
    const pending = await publish(h, makeBundle({ title: 'Waiting Room' }));
    h.d1.works.get(pending.id)!.listing_state = 'pending';
    const refused = await publish(h, makeBundle({ title: 'Refused One' }));
    h.d1.works.get(refused.id)!.listing_state = 'refused';
    const held = await publish(h, makeBundle({ title: 'Held One' }));
    h.d1.works.get(held.id)!.listing_state = 'held';
    const removed = await publish(h, makeBundle({ title: 'Removed One' }));
    forceList(h, removed.id, new Date().toISOString());
    await adminPost(h, `/api/admin/works/${removed.id}/remove`, {});

    const res = await dispatch(h, new Request(`${BASE}/shelf`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('The Visible One');
    expect(html).toContain(`href="/w/${listed.id}"`); // card links to the reading page
    for (const absent of ['Merely Linked', 'Waiting Room', 'Refused One', 'Held One', 'Removed One']) {
      expect(html, absent).not.toContain(absent);
    }
    expect(html).toContain('1 work'); // the count matches what is visible
  });

  it('is the ONE route without noindex: header absent, meta absent, description present; /w/* keeps noindex', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    forceList(h, id, new Date().toISOString());

    const shelf = await dispatch(h, new Request(`${BASE}/shelf`));
    expect(shelf.status).toBe(200);
    expect(shelf.headers.get('x-robots-tag')).toBeNull();
    expect(shelf.headers.get('cache-control')).toBe('public, max-age=60');
    expect(shelf.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await shelf.text();
    expect(html).not.toContain('noindex');
    expect(html).toContain('<meta name="description"');

    const reading = await dispatch(h, new Request(`${BASE}/w/${id}`));
    expect(reading.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const landing = await dispatch(h, new Request(`${BASE}/`));
    expect(landing.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await landing.text()).toContain('href="/shelf"'); // the quiet third CTA
  });

  it('filters by rating and language, chips link plainly, filtered count matches', async () => {
    const h = makeEnv();
    await publishListed(h, 1, (b) => {
      b.title = 'Mature English';
      b.rating = 'mature';
    });
    const huIds = await publish(h, makeBundle({ title: 'Magyar Mese', language: 'hu' }));
    forceList(h, huIds.id, new Date(Date.UTC(2026, 1, 1)).toISOString());

    const mature = await (await dispatch(h, new Request(`${BASE}/shelf?rating=mature`))).text();
    expect(mature).toContain('Mature English');
    expect(mature).not.toContain('Magyar Mese');
    expect(mature).toContain('1 work');

    const hu = await (await dispatch(h, new Request(`${BASE}/shelf?lang=hu`))).text();
    expect(hu).toContain('Magyar Mese');
    expect(hu).not.toContain('Mature English');
    expect(hu).toContain('lang-tag'); // non-en works carry the language tag

    const both = await (await dispatch(h, new Request(`${BASE}/shelf?rating=general&lang=hu`))).text();
    expect(both).toContain('Magyar Mese');

    const none = await (await dispatch(h, new Request(`${BASE}/shelf?rating=explicit`))).text();
    expect(none).toContain('Nothing on this shelf yet');
    expect(none).toContain('0 works');
  });

  it('paginates at 24 per page with plain Older/Newer links, newest listing first', async () => {
    const h = makeEnv();
    const ids = await publishListed(h, 25);
    const newestId = ids[24] ?? '';
    const oldestId = ids[0] ?? '';

    const p1res = await dispatch(h, new Request(`${BASE}/shelf`));
    const p1 = await p1res.text();
    expect(p1).toContain('25 works');
    expect(p1).toContain(`href="/w/${newestId}"`);
    expect(p1).not.toContain(`href="/w/${oldestId}"`); // page 2 material
    expect(p1).toContain('href="/shelf?page=2"');
    expect(p1).toContain('Older');
    expect(p1).not.toContain('Newer');

    const p2 = await (await dispatch(h, new Request(`${BASE}/shelf?page=2`))).text();
    expect(p2).toContain(`href="/w/${oldestId}"`);
    expect(p2).not.toContain(`href="/w/${newestId}"`);
    expect(p2).toContain('href="/shelf"'); // Newer goes back to the clean page 1
    expect(p2).toContain('Newer');
    expect(p2).not.toContain('Older');

    // Past the end: empty state, no crash.
    const p3 = await (await dispatch(h, new Request(`${BASE}/shelf?page=3`))).text();
    expect(p3).toContain('Nothing on this shelf yet');
  });

  it('cards carry cover, first line, badge, warning count, tabular words — and NO view counts', async () => {
    const h = makeEnv();
    const general = await publish(
      h,
      makeBundle({ title: 'A Quiet Book', warnings: ['graphic-violence', 'self-harm'] }),
    );
    forceList(h, general.id, new Date(Date.UTC(2026, 0, 1)).toISOString());
    h.d1.works.get(general.id)!.views = 12345678; // must never surface

    const html = await (await dispatch(h, new Request(`${BASE}/shelf`))).text();
    expect(html).toContain('class="cover"');
    expect(html).toContain('linear-gradient'); // typographic cover gradient
    expect(html).toContain('Two hearts, one soul.'); // first_line teaser
    expect(html).toContain('badge-general');
    expect(html).toContain('+2 warnings'); // count, never the full list
    expect(html).not.toContain('Graphic violence');
    expect(html).toContain('8 words');
    // The no-metrics decision: no opens, no views, no ranking vocabulary.
    expect(html).not.toContain('12345678');
    expect(html).not.toContain('opens');
    expect(html.toLowerCase()).not.toContain('trending');
  });

  it('explicit cards get the synopsis-free treatment: badge yes, first line no, link intact', async () => {
    const h = makeEnv();
    const { id } = await publish(h, makeBundle({ rating: 'explicit', warnings: ['sexual-content'] }));
    forceList(h, id, new Date().toISOString());

    const html = await (await dispatch(h, new Request(`${BASE}/shelf`))).text();
    expect(html).toContain('badge-explicit');
    expect(html).toContain(`href="/w/${id}"`);
    expect(html).not.toContain('Two hearts, one soul.'); // no prose teaser on explicit cards
  });

  it('the cover gradient is deterministic per work id', async () => {
    const h = makeEnv();
    const { id } = await publish(h);
    forceList(h, id, new Date().toISOString());
    const first = await (await dispatch(h, new Request(`${BASE}/shelf`))).text();
    const second = await (await dispatch(h, new Request(`${BASE}/shelf`))).text();
    const gradient = (html: string): string => html.match(/linear-gradient\([^)]+\)/)?.[0] ?? '';
    expect(gradient(first)).not.toBe('');
    expect(gradient(first)).toBe(gradient(second));
  });
});

describe('purge cron vs listed works', () => {
  it('skips listed works past their expiry — listing suspends the clock', async () => {
    const h = makeEnv();
    const listed = await publish(h);
    const unlisted = await publish(h);
    forceList(h, listed.id, new Date().toISOString());
    h.d1.works.get(listed.id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    h.d1.works.get(unlisted.id)!.expires_at = new Date(Date.now() - 1000).toISOString();

    const { ctx, drain } = makeCtx();
    await worker.scheduled({} as ScheduledController, h.env, ctx);
    await drain();

    expect(h.d1.works.has(listed.id)).toBe(true);
    expect(h.r2.store.has(`works/${listed.id}/index.html`)).toBe(true);
    expect(h.d1.works.has(unlisted.id)).toBe(false);
  });
});

// ---------- API-spend budget guards — daily cap + content-hash dedup ----------

describe('moderation budget — global daily cap', () => {
  it('publishes beyond the cap store a skipped verdict: zero API calls, no Discord', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({
      ANTHROPIC_API_KEY: 'sk-test',
      DISCORD_WEBHOOK: 'https://discord.example/hook',
      CHAIN_DAILY_CAP: '2',
    });

    const a = await publish(h, makeModeratedBundle('First manuscript, its own prose entirely. '.repeat(6)));
    const b = await publish(h, makeModeratedBundle('Second manuscript, different words again. '.repeat(6)));
    expect(storedVerdict(h, a.id)?.['outcome']).toBe('pass');
    expect(storedVerdict(h, b.id)?.['outcome']).toBe('pass');
    const callsAtCap = anthropicCalls(calls).length;
    expect(callsAtCap).toBeGreaterThan(0);

    const c = await publish(h, makeModeratedBundle('Third manuscript arrives over budget now. '.repeat(6)));
    const verdict = storedVerdict(h, c.id);
    expect(verdict?.['outcome']).toBe('skipped');
    expect(verdict?.['reason']).toBe('daily budget reached');
    expect(verdict?.['model']).toBe('');
    expect(verdict?.['ms']).toBe(0);
    // The N+1th run spent nothing and pinged nobody.
    expect(anthropicCalls(calls).length).toBe(callsAtCap);
    expect(discordCalls(calls)).toHaveLength(0);
  });

  it('the counter is day-keyed: another day\'s spend never throttles today', async () => {
    stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', CHAIN_DAILY_CAP: '1' });
    // A busy day in the past under a different UTC key — irrelevant today.
    h.d1.settings.set(chainRunsKey(new Date('1999-01-01T12:00:00Z')), '9999');

    const { id } = await publish(h, makeModeratedBundle());
    expect(storedVerdict(h, id)?.['outcome']).toBe('pass');
    expect(h.d1.settings.get(chainRunsKey())).toBe('1');

    // …while today's own key at the cap throttles the next run.
    const over = await publish(h, makeModeratedBundle('Fresh prose to dodge the dedup. '.repeat(8)));
    expect(storedVerdict(h, over.id)?.['outcome']).toBe('skipped');
  });

  it('a failed chain run still counts against the budget', async () => {
    stubModerationFetch({ anthropicStatus: 500 });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id } = await publish(h, makeModeratedBundle());
    expect(storedVerdict(h, id)?.['outcome']).toBe('error');
    // The attempt was consumed — error loops cannot burn free retries.
    expect(h.d1.settings.get(chainRunsKey())).toBe('1');
  });

  it('CHAIN_DAILY_CAP unset → the default cap of 100 applies', async () => {
    stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    h.d1.settings.set(chainRunsKey(), '99');
    const ok = await publish(h, makeModeratedBundle());
    expect(storedVerdict(h, ok.id)?.['outcome']).toBe('pass'); // run 100 of 100
    const over = await publish(h, makeModeratedBundle('Different prose for run 101 today. '.repeat(8)));
    expect(storedVerdict(h, over.id)?.['outcome']).toBe('skipped');
  });

  it('listing request over budget → held manual + Discord budget note; NEVER listed', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({
      ANTHROPIC_API_KEY: 'sk-test',
      DISCORD_WEBHOOK: 'https://discord.example/hook',
      CHAIN_DAILY_CAP: '1',
    });
    // A small work: no shadow run (<200 chars), no stored verdict to reuse.
    const { id, manageSecret } = await publish(h);
    h.d1.settings.set(chainRunsKey(), '1'); // today's budget already spent

    const res = await putListing(h, id, manageSecret, true);
    expect(res.status).toBe(200); // the request itself is never blocked

    const row = h.d1.works.get(id);
    expect(row?.listing_state).toBe('held');
    expect(row?.listed).toBe(0);
    expect(listingVerdictOf(h, id)).toEqual({ reason: 'manual' });
    expect(anthropicCalls(calls)).toHaveLength(0);

    const discord = discordCalls(calls);
    expect(discord).toHaveLength(1);
    const payload = JSON.stringify(discord[0]?.body);
    expect(payload).toContain('LISTING REQUEST');
    expect(payload).toContain('chain budget reached');
  });

  it('budget exhaustion never blocks link-publishing: the publish response is a plain 200', async () => {
    stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', CHAIN_DAILY_CAP: '1' });
    h.d1.settings.set(chainRunsKey(), '1');
    const { id, url } = await publish(h, makeModeratedBundle()); // asserts 200 inside
    expect(url).toBe(`${BASE}/w/${id}`);
    expect(h.r2.store.has(`works/${id}/index.html`)).toBe(true);
  });
});

describe('content-hash dedup — never pay twice for the same prose', () => {
  function putUpdate(h: Harness, id: string, secret: string, bundle: PublishBundleV1): Promise<Response> {
    return dispatch(
      h,
      new Request(`${BASE}/api/works/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-manage-secret': secret },
        body: JSON.stringify(bundle),
      }),
    );
  }

  it('publish stores the content hash on the row', async () => {
    stubModerationFetch({});
    const h = makeEnv();
    const { id } = await publish(h);
    expect(h.d1.works.get(id)?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('update with identical content skips the chain: no API calls, old verdict untouched', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const bundle = makeModeratedBundle();
    const { id, manageSecret } = await publish(h, bundle);
    expect(storedVerdict(h, id)?.['outcome']).toBe('pass');
    const callsAfterPublish = anthropicCalls(calls).length;
    const verdictRaw = h.d1.works.get(id)?.moderation_verdict;
    const verdictAt = h.d1.works.get(id)?.moderation_at;
    const runsAfterPublish = h.d1.settings.get(chainRunsKey());

    const res = await putUpdate(h, id, manageSecret, makeModeratedBundle());
    expect(res.status).toBe(200);
    expect(anthropicCalls(calls).length).toBe(callsAfterPublish);
    expect(h.d1.works.get(id)?.moderation_verdict).toBe(verdictRaw);
    expect(h.d1.works.get(id)?.moderation_at).toBe(verdictAt);
    // No budget consumed either.
    expect(h.d1.settings.get(chainRunsKey())).toBe(runsAfterPublish);
  });

  it('update with changed prose stores the new hash and re-runs the chain', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    const oldHash = h.d1.works.get(id)?.content_hash;
    const callsAfterPublish = anthropicCalls(calls).length;

    const res = await putUpdate(h, id, manageSecret, makeModeratedBundle('The revised draft says different things. '.repeat(6)));
    expect(res.status).toBe(200);
    expect(h.d1.works.get(id)?.content_hash).not.toBe(oldHash);
    expect(anthropicCalls(calls).length).toBeGreaterThan(callsAfterPublish);
  });

  it('update with identical prose but changed labels re-runs the chain (labels are verdict inputs)', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    const callsAfterPublish = anthropicCalls(calls).length;

    const relabeled = makeModeratedBundle();
    relabeled.rating = 'mature';
    const res = await putUpdate(h, id, manageSecret, relabeled);
    expect(res.status).toBe(200);
    expect(anthropicCalls(calls).length).toBeGreaterThan(callsAfterPublish);
  });

  it('pre-0006 row (NULL hash) = unknown: an identical update still runs the chain', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    h.d1.works.get(id)!.content_hash = null;
    const callsAfterPublish = anthropicCalls(calls).length;

    const res = await putUpdate(h, id, manageSecret, makeModeratedBundle());
    expect(res.status).toBe(200);
    expect(anthropicCalls(calls).length).toBeGreaterThan(callsAfterPublish);
    // …and the hash backfills for next time.
    expect(h.d1.works.get(id)?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('listing gate — verdict reuse', () => {
  it('fresh pass verdict + matching hash → listed with {reused:true}, zero API calls', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    expect(storedVerdict(h, id)?.['outcome']).toBe('pass');
    const callsAfterPublish = anthropicCalls(calls).length;
    const runsAfterPublish = h.d1.settings.get(chainRunsKey());
    const verdictAt = h.d1.works.get(id)?.moderation_at;

    await putListing(h, id, manageSecret, true);

    const row = h.d1.works.get(id);
    expect(row?.listing_state).toBe('listed');
    expect(row?.listed).toBe(1);
    expect(listingVerdictOf(h, id)).toEqual({ reused: true });
    // Zero new API calls, zero budget, verdict record untouched.
    expect(anthropicCalls(calls).length).toBe(callsAfterPublish);
    expect(h.d1.settings.get(chainRunsKey())).toBe(runsAfterPublish);
    expect(h.d1.works.get(id)?.moderation_at).toBe(verdictAt);
    // The operator still sees the arrival.
    expect(JSON.stringify(discordCalls(calls).map((c) => c.body))).toContain('Listed on the Shelf');
  });

  it('reused tag-fix verdict → refused with the suggestion and {reused:true}, zero API calls', async () => {
    const { calls } = stubModerationFetch({
      routerFlags: () => ['sexual-explicit'],
      verifier: {
        hardLine: 'none',
        reason: 'explicit content without labels',
        labels: 'under-labeled',
        suggested: { rating: 'explicit', warnings: ['sexual-content'] },
      },
    });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    expect(storedVerdict(h, id)?.['outcome']).toBe('tag-fix');
    const callsAfterPublish = anthropicCalls(calls).length;

    await putListing(h, id, manageSecret, true);

    expect(h.d1.works.get(id)?.listing_state).toBe('refused');
    expect(listingVerdictOf(h, id)).toEqual({
      reason: 'labels',
      suggested: { rating: 'explicit', warnings: ['sexual-content'] },
      reused: true,
    });
    expect(anthropicCalls(calls).length).toBe(callsAfterPublish);
  });

  it('accepting the suggested labels stales the reused verdict: the retry re-judges and lists', async () => {
    // Same-prose relabel MUST invalidate reuse, or a reused tag-fix would
    // refuse forever (and a reused pass could carry stale labels unreviewed).
    const { calls } = stubModerationFetch({
      routerFlags: () => ['sexual-explicit'],
      verifier: {
        hardLine: 'none',
        reason: 'explicit content without labels',
        labels: 'under-labeled',
        suggested: { rating: 'explicit', warnings: ['sexual-content'] },
      },
    });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    await putListing(h, id, manageSecret, true); // reused tag-fix → refused
    expect(h.d1.works.get(id)?.listing_state).toBe('refused');

    await putLabels(h, id, manageSecret, 'explicit', ['sexual-content']);
    expect(h.d1.works.get(id)?.content_hash).toBeNull(); // relabel stales the hash

    const callsBeforeRetry = anthropicCalls(calls).length;
    await putListing(h, id, manageSecret, true);
    expect(h.d1.works.get(id)?.listing_state).toBe('listed');
    // The retry ran the chain fresh (router-only pass — labels now cover).
    expect(anthropicCalls(calls).length).toBeGreaterThan(callsBeforeRetry);
  });

  it('stale hash → the gate runs the chain instead of reusing', async () => {
    const { calls } = stubModerationFetch({});
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    h.d1.works.get(id)!.content_hash = 'f'.repeat(64); // verdict is for other prose
    const callsAfterPublish = anthropicCalls(calls).length;

    await putListing(h, id, manageSecret, true);

    expect(anthropicCalls(calls).length).toBeGreaterThan(callsAfterPublish);
    expect(h.d1.works.get(id)?.listing_state).toBe('listed');
    expect(h.d1.works.get(id)?.listing_verdict).toBeNull(); // fresh run, no reused mark
  });

  it('an error verdict is never reused — the gate runs the chain', async () => {
    stubModerationFetch({ anthropicStatus: 500 });
    const h = makeEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    const { id, manageSecret } = await publish(h, makeModeratedBundle());
    expect(storedVerdict(h, id)?.['outcome']).toBe('error'); // hash matches, verdict broken

    const { calls } = stubModerationFetch({}); // the API recovers
    await putListing(h, id, manageSecret, true);

    expect(anthropicCalls(calls).length).toBeGreaterThan(0);
    expect(h.d1.works.get(id)?.listing_state).toBe('listed');
  });
});

describe('admin overview — chain budget visibility', () => {
  it('carries { chainBudget: { cap, usedToday } }', async () => {
    stubModerationFetch({});
    const h = makeEnv({ ADMIN_SECRET, ANTHROPIC_API_KEY: 'sk-test', CHAIN_DAILY_CAP: '7' });
    await publish(h, makeModeratedBundle()); // one shadow run today

    const o = (await (await adminGet(h, '/api/admin/overview')).json()) as Overview & {
      chainBudget: { cap: number; usedToday: number };
    };
    expect(o.chainBudget).toEqual({ cap: 7, usedToday: 1 });
  });

  it('reads zero used and the default cap on a quiet day', async () => {
    const h = makeEnv({ ADMIN_SECRET });
    const o = (await (await adminGet(h, '/api/admin/overview')).json()) as Overview & {
      chainBudget: { cap: number; usedToday: number };
    };
    expect(o.chainBudget).toEqual({ cap: 100, usedToday: 0 });
  });
});
