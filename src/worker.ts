/**
 * The Shelf — Cloudflare Worker entry (shelf.inkmirror.cc).
 *
 * Routes (Phase 1 + 1.5):
 *   POST   /api/publish           validate + gates + bake + store → { id, url, manageSecret }
 *   GET    /api/works/:id         meta JSON                      [X-Manage-Secret]
 *   PUT    /api/works/:id         replace content (re-bake)      [X-Manage-Secret]
 *   DELETE /api/works/:id         unpublish                      [X-Manage-Secret]
 *   POST   /api/works/:id/renew   push expiry +30d               [X-Manage-Secret]
 *   POST   /api/works/:id/report  rule-violation report → D1 + Discord webhook
 *   *      /api/admin/*           operator toolkit               [X-Admin-Secret]
 *   GET    /w/:id                 baked reading page from R2 (+ age gate)
 *   GET    /w/:id/manage          manage page (secret lives in URL fragment)
 *   GET    /w/:id/report          live report form (+ optional Turnstile)
 *   GET    /admin                 operator console (secret lives in URL fragment)
 *   GET    /                      landing
 *   GET    /rules                 ratings, warning tags, hard lines
 *   cron   daily                  purge expired works + removed works past grace
 */

import type { Env } from './worker/lib/env';
import { WORK_ID_RE, preflightResponse, withCors } from './worker/lib/http';
import { bundleKey, deleteWork, listExpired, listRemovedBefore, pageKey } from './worker/lib/db';
import { handlePublish } from './worker/routes/publish';
import { handleManage } from './worker/routes/manage';
import { handleReport, reportPage } from './worker/routes/report';
import { handleAdmin } from './worker/routes/admin';
import { handleRead, notFoundPage } from './worker/routes/read';
import { landingPage } from './worker/pages/landing';
import { rulesPage } from './worker/pages/rules';
import { managePage } from './worker/pages/manage-page';
import { adminPage } from './worker/pages/admin-page';

// NOTE: the Worker entry module may only export handlers (workerd rejects
// value exports) — shared constants (WORK_ID_RE, PUBLISH_ALLOWED_ORIGIN)
// live in src/worker/lib/http.ts.
export type { Env };

/**
 * Strict CSP for Worker-generated HTML. Everything is inline by design
 * (no external assets can exist under default-src 'none'); connect-src
 * 'self' is required by the manage page's same-origin API calls.
 */
const HTML_CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  "connect-src 'self'; " +
  "img-src 'self' data:; " +
  "form-action 'self'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'";

function withBaseHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  // Published pages are shareable but never indexable.
  headers.set('x-robots-tag', 'noindex, nofollow');
  // A route may ship its own CSP (only /w/:id/report does, for Turnstile);
  // everything else gets the strict inline-only policy.
  if (
    (headers.get('content-type') ?? '').includes('text/html') &&
    !headers.has('content-security-policy')
  ) {
    headers.set('content-security-policy', HTML_CSP);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const res = await route(request, env, ctx, path, method);
    const withHeaders = withBaseHeaders(res);
    return path.startsWith('/api/') ? withCors(request, withHeaders) : withHeaders;
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgeExpired(env));
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
  method: string,
): Promise<Response> {
  if (path === '/api/publish') {
    if (method === 'OPTIONS') return preflightResponse(request);
    if (method === 'POST') return await handlePublish(request, env);
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  // Operator surface — same-origin only (the /admin console), no preflight.
  if (path.startsWith('/api/admin/')) {
    return await handleAdmin(request, env, path, method);
  }

  const workMatch = path.match(/^\/api\/works\/([^/]{1,64})(\/(renew|report))?$/);
  if (workMatch) {
    const [, id, , action] = workMatch;
    if (method === 'OPTIONS') return preflightResponse(request);
    if (!WORK_ID_RE.test(id ?? '')) {
      // Same shape as an auth miss — invalid ids are not distinguishable.
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const workId = id ?? '';
    if (action === 'report' && method === 'POST') return await handleReport(request, env, workId);
    if (action === 'renew' && method === 'POST') return await handleManage(request, env, workId, 'renew');
    if (!action && method === 'GET') return await handleManage(request, env, workId, 'meta');
    if (!action && method === 'PUT') return await handleManage(request, env, workId, 'update');
    if (!action && method === 'DELETE') return await handleManage(request, env, workId, 'unpublish');
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const readMatch = path.match(/^\/w\/([^/]{1,64})(\/(manage|report))?$/);
  if (readMatch && method === 'GET') {
    const [, id, , sub] = readMatch;
    if (!WORK_ID_RE.test(id ?? '')) return notFoundPage();
    const workId = id ?? '';
    if (sub === 'manage') return managePage(workId);
    if (sub === 'report') return await reportPage(env, workId);
    return await handleRead(request, env, ctx, workId);
  }

  if (method === 'GET' && path === '/') return landingPage();
  if (method === 'GET' && path === '/rules') return rulesPage();
  if (method === 'GET' && path === '/admin') return adminPage();

  return notFoundPage();
}

/**
 * Daily cron: evaporate unlisted works past their expiry, plus operator-
 * removed works whose 30-day grace window (restore period) has passed.
 */
const PURGE_BATCH = 500;
const REMOVED_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function purgeExpired(env: Env): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const graceCutoffIso = new Date(now - REMOVED_GRACE_MS).toISOString();
  for (;;) {
    const ids = await listExpired(env.SHELF_DB, nowIso, PURGE_BATCH);
    for (const id of ids) {
      await env.SHELF_R2.delete([bundleKey(id), pageKey(id)]);
      await deleteWork(env.SHELF_DB, id);
    }
    if (ids.length < PURGE_BATCH) break;
  }
  for (;;) {
    const ids = await listRemovedBefore(env.SHELF_DB, graceCutoffIso, PURGE_BATCH);
    for (const id of ids) {
      await env.SHELF_R2.delete([bundleKey(id), pageKey(id)]);
      await deleteWork(env.SHELF_DB, id);
    }
    if (ids.length < PURGE_BATCH) break;
  }
}
