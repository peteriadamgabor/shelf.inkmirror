import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './worker';
import type { Env } from './worker/lib/env';
import type { WorkRow } from './worker/lib/db';
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

/** Understands exactly the SQL statements in src/worker/lib/db.ts. */
class FakeD1 {
  works = new Map<string, WorkRow>();
  reports: FakeReport[] = [];
  tombstones = new Map<string, FakeTombstone>();
  settings = new Map<string, string>();
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

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    if (s.includes('SELECT * FROM works WHERE id')) {
      return (this.works.get(String(this.args[0])) as T | undefined) ?? null;
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
      const [id, secret_hash, title, pen_name, language, rating, warnings, word_count, first_line, created_at, updated_at, expires_at] = a;
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
      });
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
      const row = this.works.get(String(a[6]));
      if (row) {
        row.title = String(a[0]);
        row.rating = String(a[1]);
        row.warnings = String(a[2]);
        row.word_count = Number(a[3]);
        row.first_line = String(a[4]);
        row.updated_at = String(a[5]);
      }
      return { success: true };
    }
    if (s.includes("SET status = 'removed'")) {
      const row = this.works.get(String(a[1]));
      if (row) {
        row.status = 'removed';
        row.removed_at = String(a[0]);
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
      }
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
          status: w.status, created_at: w.created_at, expires_at: w.expires_at,
        }) as T);
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
}

function makeEnv(overrides: Partial<Env> = {}): Harness {
  const r2 = new FakeR2();
  const d1 = new FakeD1();
  const rlPublish = new FakeRateLimit();
  const rlManage = new FakeRateLimit();
  const rlReport = new FakeRateLimit();
  const rlViews = new FakeRateLimit();
  const env = {
    SHELF_R2: r2 as unknown as R2Bucket,
    SHELF_DB: d1 as unknown as D1Database,
    RL_PUBLISH: rlPublish,
    RL_MANAGE: rlManage,
    RL_REPORT: rlReport,
    RL_VIEWS: rlViews,
    ...overrides,
  } satisfies Env;
  return { env, r2, d1, rlPublish, rlManage, rlReport, rlViews };
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
