/**
 * The Shelf — Cloudflare Worker entry (shelf.inkmirror.cc).
 *
 * Routes (Phase 1 + 1.5 + password tier + letters + Phase 3 shelf):
 *   POST   /api/publish           validate + gates + bake + store → { id, url, manageSecret }
 *   GET    /api/works/:id         meta JSON (incl. passwordProtected) [X-Manage-Secret]
 *   PUT    /api/works/:id         replace content (re-bake)      [X-Manage-Secret]
 *   DELETE /api/works/:id         unpublish                      [X-Manage-Secret]
 *   POST   /api/works/:id/renew   push expiry +30d               [X-Manage-Secret]
 *   PUT    /api/works/:id/password  set/clear the reading password [X-Manage-Secret]
 *   PUT    /api/works/:id/listing { list } request/withdraw a shelf listing [X-Manage-Secret]
 *   PUT    /api/works/:id/labels  { rating, warnings } accept-labels re-bake [X-Manage-Secret]
 *   POST   /api/works/:id/report  rule-violation report → D1 + Discord webhook
 *   POST   /api/works/:id/letters reader → author letter (D1 only, no Discord)
 *   GET    /api/works/:id/letters author's inbox                 [X-Manage-Secret]
 *   DELETE /api/works/:id/letters/:letterId                      [X-Manage-Secret]
 *   PUT    /api/works/:id/letters-open  toggle the mailbox       [X-Manage-Secret]
 *   *      /api/admin/*           operator toolkit               [X-Admin-Secret]
 *   GET    /w/:id                 baked cover / single page from R2 (+ age gate,
 *                                 + password gate); counts the view (never on the gate)
 *   GET    /w/:id/:n              baked chapter page n (1-999) from R2; never counts views
 *   POST   /w/:id/unlock          password gate unlock → cookie + 303
 *   GET    /w/:id/manage          manage page (secret lives in URL fragment)
 *   GET    /w/:id/report          live report form (+ optional Turnstile)
 *   GET    /w/:id/letter          live letter form (404 while letters are closed)
 *   GET    /admin                 operator console (secret lives in URL fragment)
 *   GET    /                      landing
 *   GET    /shelf                 public browse page — live-rendered, the ONE indexable route
 *   GET    /rules                 ratings, warning tags, hard lines
 *   cron   daily                  purge expired works + removed works past grace
 *                                 (listed works are exempt while listed)
 */

import type { Env } from './worker/lib/env';
import { WORK_ID_RE, preflightResponse, withCors } from './worker/lib/http';
import { deleteWorkObjects, listWorkIds } from './worker/lib/bake';
import { reportException } from './worker/lib/glitchtip';
import { runBackup } from './worker/lib/backup';
import { deleteWork, listExpired, listInvariantViolations, listRemovedBefore, workExists } from './worker/lib/db';
import { handlePublish } from './worker/routes/publish';
import { handleManage } from './worker/routes/manage';
import { handleReport, reportPage } from './worker/routes/report';
import { handleLetterSubmit, letterPage } from './worker/routes/letters';
import { handleUnlock } from './worker/routes/unlock';
import { handleAdmin } from './worker/routes/admin';
import { handleRead, handleReadChapter, notFoundPage } from './worker/routes/read';
import { handleCover } from './worker/routes/cover';
import { langForRequest } from './worker/i18n';
import { landingPage } from './worker/pages/landing';
import { shelfPage } from './worker/pages/shelf-page';
import { rulesPage } from './worker/pages/rules';
import { termsPage } from './worker/pages/terms';
import { privacyPage } from './worker/pages/privacy';
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

function withBaseHeaders(res: Response, indexable: boolean): Response {
  const headers = new Headers(res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  // Published pages are shareable but never indexable — with ONE exception:
  // /shelf is the public browse surface and opts out (same pattern as the
  // CSP passthrough below). /w/* stays noindex regardless of rating.
  if (!indexable) headers.set('x-robots-tag', 'noindex, nofollow');
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

/** The ONE indexable route on the domain (CLAUDE.md rule 6). */
const INDEXABLE_PATHS = new Set(['/shelf']);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      const res = await route(request, env, ctx, url, path, method);
      const withHeaders = withBaseHeaders(res, INDEXABLE_PATHS.has(path));
      return path.startsWith('/api/') ? withCors(request, withHeaders) : withHeaders;
    } catch (e) {
      // An uncaught handler exception is reported server-side (never from a
      // reader's browser) and answered with a clean, opaque 500.
      ctx.waitUntil(reportException(env, e, request));
      console.error(`[worker] uncaught ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
      const body = path.startsWith('/api/')
        ? JSON.stringify({ error: 'internal_error' })
        : 'Something went wrong.';
      const ct = path.startsWith('/api/') ? 'application/json' : 'text/plain; charset=utf-8';
      return withBaseHeaders(new Response(body, { status: 500, headers: { 'content-type': ct } }), false);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      dailyMaintenance(env).catch((e) => {
        ctx.waitUntil(reportException(env, e, new Request('https://shelf.inkmirror.cc/__cron')));
        console.error(`[cron] failed: ${e instanceof Error ? e.message : String(e)}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  path: string,
  method: string,
): Promise<Response> {
  if (path === '/api/publish') {
    if (method === 'OPTIONS') return preflightResponse(request);
    if (method === 'POST') return await handlePublish(request, env, ctx);
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  // Operator surface — same-origin only (the /admin console), no preflight.
  if (path.startsWith('/api/admin/')) {
    return await handleAdmin(request, env, path, method);
  }

  // One letter of the author's inbox: /api/works/:id/letters/:letterId.
  const letterItemMatch = path.match(/^\/api\/works\/([^/]{1,64})\/letters\/([^/]{1,64})$/);
  if (letterItemMatch) {
    const [, id, letterId] = letterItemMatch;
    if (method === 'OPTIONS') return preflightResponse(request);
    if (!WORK_ID_RE.test(id ?? '') || !WORK_ID_RE.test(letterId ?? '')) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (method === 'DELETE') {
      return await handleManage(request, env, ctx, id ?? '', 'letter-delete', letterId ?? '');
    }
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const workMatch = path.match(/^\/api\/works\/([^/]{1,64})(\/(renew|report|password|listing|labels|letters|letters-open))?$/);
  if (workMatch) {
    const [, id, , action] = workMatch;
    if (method === 'OPTIONS') return preflightResponse(request);
    if (!WORK_ID_RE.test(id ?? '')) {
      // Same shape as an auth miss — invalid ids are not distinguishable.
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const workId = id ?? '';
    if (action === 'report' && method === 'POST') return await handleReport(request, env, workId);
    if (action === 'renew' && method === 'POST') return await handleManage(request, env, ctx, workId, 'renew');
    if (action === 'password' && method === 'PUT') return await handleManage(request, env, ctx, workId, 'password');
    if (action === 'listing' && method === 'PUT') return await handleManage(request, env, ctx, workId, 'listing');
    if (action === 'labels' && method === 'PUT') return await handleManage(request, env, ctx, workId, 'labels');
    if (action === 'letters' && method === 'POST') return await handleLetterSubmit(request, env, workId);
    if (action === 'letters' && method === 'GET') return await handleManage(request, env, ctx, workId, 'letters');
    if (action === 'letters-open' && method === 'PUT') return await handleManage(request, env, ctx, workId, 'letters-open');
    if (!action && method === 'GET') return await handleManage(request, env, ctx, workId, 'meta');
    if (!action && method === 'PUT') return await handleManage(request, env, ctx, workId, 'update');
    if (!action && method === 'DELETE') return await handleManage(request, env, ctx, workId, 'unpublish');
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const readMatch = path.match(/^\/w\/([^/]{1,64})(\/(manage|report|letter|cover))?$/);
  if (readMatch && method === 'GET') {
    const [, id, , sub] = readMatch;
    if (!WORK_ID_RE.test(id ?? '')) return notFoundPage(langForRequest(request, url));
    const workId = id ?? '';
    if (sub === 'manage') return managePage(workId);
    if (sub === 'report') return await reportPage(request, env, workId);
    if (sub === 'letter') return await letterPage(request, env, workId);
    if (sub === 'cover') return await handleCover(request, env, workId);
    return await handleRead(request, env, ctx, workId);
  }

  // Password gate unlock — form POST only.
  const unlockMatch = path.match(/^\/w\/([^/]{1,64})\/unlock$/);
  if (unlockMatch && method === 'POST') {
    const [, id] = unlockMatch;
    if (!WORK_ID_RE.test(id ?? '')) return notFoundPage(langForRequest(request, url));
    return await handleUnlock(request, env, id ?? '');
  }

  // Chapter pages: n = 1..999, no leading zeros — anything else (0, 01, non-
  // numeric) falls through to the styled 404 at the bottom.
  const chapterMatch = path.match(/^\/w\/([^/]{1,64})\/([1-9]\d{0,2})$/);
  if (chapterMatch && method === 'GET') {
    const [, id, n] = chapterMatch;
    if (!WORK_ID_RE.test(id ?? '')) return notFoundPage(langForRequest(request, url));
    return await handleReadChapter(request, env, id ?? '', Number(n));
  }

  if (method === 'GET' && path === '/') return landingPage(langForRequest(request, url));
  if (method === 'GET' && path === '/shelf') return await shelfPage(url, env, langForRequest(request, url));
  if (method === 'GET' && path === '/rules') return rulesPage();
  if (method === 'GET' && path === '/terms') return termsPage();
  if (method === 'GET' && path === '/privacy') return privacyPage();
  if (method === 'GET' && path === '/admin') return adminPage();

  return notFoundPage(langForRequest(request, url));
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
      await deleteWorkObjects(env.SHELF_R2, id);
      await deleteWork(env.SHELF_DB, id);
    }
    if (ids.length < PURGE_BATCH) break;
  }
  for (;;) {
    const ids = await listRemovedBefore(env.SHELF_DB, graceCutoffIso, PURGE_BATCH);
    for (const id of ids) {
      await deleteWorkObjects(env.SHELF_R2, id);
      await deleteWork(env.SHELF_DB, id);
    }
    if (ids.length < PURGE_BATCH) break;
  }
}

/** Objects to inspect per orphan-sweep run — bounded to stay within CPU limits. */
const ORPHAN_SWEEP_LIMIT = 5000;

/**
 * R2/D1 writes are not transactional (D1 gates every read, so an orphaned R2
 * object is litter, not exposure). This sweep is the reconciliation: any
 * `works/{id}/` prefix whose D1 row is gone gets its objects deleted.
 */
async function sweepOrphans(env: Env): Promise<void> {
  const ids = await listWorkIds(env.SHELF_R2, ORPHAN_SWEEP_LIMIT);
  for (const id of ids) {
    if (!(await workExists(env.SHELF_DB, id))) {
      await deleteWorkObjects(env.SHELF_R2, id);
    }
  }
}

/**
 * Canary: the listing invariant (listed=1 ⇒ listed state, active, no password)
 * is enforced in the accessor layer, but SQLite can't express it as a CHECK
 * on a live table. If a row ever violates it, alert — do not auto-fix.
 */
async function checkInvariants(env: Env): Promise<void> {
  const bad = await listInvariantViolations(env.SHELF_DB, 50);
  if (bad.length === 0) return;
  const hook = env.DISCORD_WEBHOOK;
  if (hook === undefined || hook.length === 0) return;
  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `⚠️ **Shelf integrity**: ${bad.length} listed work(s) violate the listing invariant: ${bad.join(', ').slice(0, 1500)}`,
        allowed_mentions: { parse: [] as string[] },
      }),
    });
  } catch {
    /* the next run re-checks */
  }
}

async function dailyMaintenance(env: Env): Promise<void> {
  await runBackup(env, Date.now());
  await purgeExpired(env);
  await sweepOrphans(env);
  await checkInvariants(env);
}
