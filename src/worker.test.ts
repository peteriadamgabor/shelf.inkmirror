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

/** Understands exactly the SQL statements in src/worker/lib/db.ts. */
class FakeD1 {
  works = new Map<string, WorkRow>();
  prepare(sql: string): { bind(...args: unknown[]): FakeStatement } {
    const works = this.works;
    return {
      bind(...args: unknown[]): FakeStatement {
        return new FakeStatement(sql, args, works);
      },
    };
  }
}

class FakeStatement {
  constructor(
    private sql: string,
    private args: unknown[],
    private works: Map<string, WorkRow>,
  ) {}

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('SELECT * FROM works WHERE id')) {
      return (this.works.get(String(this.args[0])) as T | undefined) ?? null;
    }
    throw new Error(`FakeD1 unhandled first(): ${this.sql}`);
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
      });
      return { success: true };
    }
    if (s.includes('SET views = views + 1')) {
      const row = this.works.get(String(a[0]));
      if (row) row.views += 1;
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
    if (s.includes('DELETE FROM works WHERE id')) {
      this.works.delete(String(a[0]));
      return { success: true };
    }
    throw new Error(`FakeD1 unhandled run(): ${s}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('SELECT id FROM works WHERE expires_at')) {
      const now = String(this.args[0]);
      const limit = Number(this.args[1]);
      const results = [...this.works.values()]
        .filter((w) => w.expires_at < now && w.listed === 0)
        .slice(0, limit)
        .map((w) => ({ id: w.id }) as T);
      return { results };
    }
    throw new Error(`FakeD1 unhandled all(): ${this.sql}`);
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
  });

  it('too-fast submit (render gate) → silently accepted, webhook NOT called', async () => {
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const res = await dispatch(h, formReport({ reason: 'other', message: '', website: '', ts: String(Date.now()) }));
    expect(res.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('legit form report → webhook called, styled confirmation page', async () => {
    const h = makeEnv({ DISCORD_WEBHOOK: 'https://discord.example/hook' });
    const res = await dispatch(
      h,
      formReport({ reason: 'mislabeled', message: 'rated general, is not', website: '', ts: String(Date.now() - 5000) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('a human will look at this');
    expect(fetch).toHaveBeenCalledOnce();
    const [hookUrl, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(hookUrl).toBe('https://discord.example/hook');
    expect(String(init.body)).toContain('mislabeled');
    expect(String(init.body)).toContain(WORK);
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

  it('webhook unset → 503 JSON', async () => {
    const h = makeEnv();
    const res = await dispatch(h, formReport({ reason: 'other', message: '', website: '', ts: String(Date.now() - 5000) }));
    expect(res.status).toBe(503);
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
});
