/**
 * The Shelf — Cloudflare Worker entry (shelf.inkmirror.cc).
 *
 * Routes (Phase 1 — currently stubs, see docs/specs/):
 *   POST   /api/publish           validate + bake + store → { id, url, manageSecret }
 *   PUT    /api/works/:id         replace content (re-bake)      [X-Manage-Secret]
 *   DELETE /api/works/:id         unpublish                      [X-Manage-Secret]
 *   POST   /api/works/:id/renew   push expiry +30d               [X-Manage-Secret]
 *   POST   /api/works/:id/report  rule-violation report → Discord webhook
 *   GET    /w/:id                 baked reading page from R2 (+ age gate)
 *   GET    /w/:id/manage          manage page (secret lives in URL fragment)
 *   GET    /                      landing
 *   GET    /rules                 ratings, warning tags, hard lines
 *   cron   daily                  purge works past expires_at (D1 row + R2 objects)
 */

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  SHELF_R2: R2Bucket;
  SHELF_DB: D1Database;
  RL_PUBLISH: RateLimit;
  RL_MANAGE: RateLimit;
  RL_REPORT: RateLimit;
  /** Report + moderation-hold notifications. Wrangler Secret. */
  DISCORD_WEBHOOK?: string;
  /** Phase 2 moderation chain. Wrangler Secret. */
  ANTHROPIC_API_KEY?: string;
}

/** Only the editor may call the publish API cross-origin. */
const PUBLISH_ALLOWED_ORIGIN = 'https://inkmirror.cc';

// 16 random bytes, base64url — 128 bits. The id IS the capability for
// unlisted works, so it gets the same entropy as the sync layer's syncId.
const WORK_ID_RE = /^[A-Za-z0-9_-]{22}$/;

function notImplemented(what: string): Response {
  return Response.json({ error: `${what}: not implemented yet` }, { status: 501 });
}

function withBaseHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  // Published pages are shareable but never indexable.
  headers.set('x-robots-tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'POST' && path === '/api/publish') {
      return withBaseHeaders(notImplemented('publish'));
    }

    const workMatch = path.match(/^\/api\/works\/([^/]{1,64})(\/(renew|report))?$/);
    if (workMatch) {
      const [, id, , action] = workMatch;
      if (!WORK_ID_RE.test(id ?? '')) {
        return withBaseHeaders(Response.json({ error: 'invalid work id' }, { status: 400 }));
      }
      if (action === 'renew' && method === 'POST') return withBaseHeaders(notImplemented('renew'));
      if (action === 'report' && method === 'POST') return withBaseHeaders(notImplemented('report'));
      if (!action && method === 'PUT') return withBaseHeaders(notImplemented('update'));
      if (!action && method === 'DELETE') return withBaseHeaders(notImplemented('unpublish'));
    }

    const readMatch = path.match(/^\/w\/([^/]{1,64})(\/manage)?$/);
    if (readMatch && method === 'GET') {
      const [, id, manage] = readMatch;
      if (!WORK_ID_RE.test(id ?? '')) {
        return withBaseHeaders(new Response('Not Found', { status: 404 }));
      }
      return withBaseHeaders(notImplemented(manage ? 'manage page' : 'reading page'));
    }

    if (method === 'GET' && (path === '/' || path === '/rules')) {
      return withBaseHeaders(notImplemented(path === '/' ? 'landing' : 'rules page'));
    }

    return withBaseHeaders(new Response('Not Found', { status: 404 }));
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Daily purge: DELETE FROM works WHERE expires_at < now AND listed = 0,
    // plus the matching works/{id}/* objects in R2. Implemented in Phase 1.
  },
} satisfies ExportedHandler<Env>;

export { PUBLISH_ALLOWED_ORIGIN };
