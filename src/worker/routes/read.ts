/**
 * GET /w/:id — serve the baked cover/single page from R2.
 * GET /w/:id/:n — serve baked chapter page n (multi-chapter works).
 *
 * D1 is the gatekeeper (status + expiry, one shared guard for both routes);
 * R2 only stores the bytes. Works with a password_hash additionally pass the
 * password gate: no valid unlock cookie → the gate page, never content.
 * View counting rides on ctx.waitUntil behind a per-(ip, work) cooldown so
 * serving is never blocked and refresh spam doesn't inflate "opens" — and it
 * happens ONLY on a successful cover serve: paging through a book is one
 * open, not twelve, and a gate serve is not an open at all.
 */

import type { Env } from '../lib/env';
import { escapeHtml, htmlResponse, pageShell } from '../../html';
import { chapterKey, getWork, incrementViews, pageKey, type WorkRow } from '../lib/db';
import { isUnlocked } from '../lib/password';
import { clientIp } from '../lib/http';
import { langForRequest, langForWork, t, type Lang } from '../i18n';
import { gatePage } from '../pages/gate-page';

export function notFoundPage(lang: Lang = 'en'): Response {
  return htmlResponse(
    pageShell({
      title: `${t(lang, 'notFound.tab')} — ${t(lang, 'brand')}`,
      lang,
      body: `<div class="page">
<h1>${escapeHtml(t(lang, 'notFound.heading'))}</h1>
<p class="muted">${t(lang, 'notFound.body')}</p>
<p><a class="btn" href="/">${escapeHtml(t(lang, 'brand'))}</a></p>
</div>`,
    }),
    404,
  );
}

/** Chrome locale for a 404 — the request's language (no work in hand). */
export function notFoundLang(request: Request): Lang {
  return langForRequest(request, new URL(request.url));
}

/**
 * The one reader-facing gate: the row must exist, be active, and be inside
 * its expiry window. Cover, chapter, report, and letter pages all pass
 * through here.
 */
export async function getActiveWork(env: Env, id: string): Promise<WorkRow | null> {
  const row = await getWork(env.SHELF_DB, id);
  if (row === null || row.status !== 'active') return null;
  const expiresMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresMs) && expiresMs < Date.now()) return null;
  return row;
}

/**
 * The password gate, shared by every reader route of a locked work. Null
 * when the request may read (no password set, or a valid unlock cookie);
 * otherwise the gate page carrying `next` so unlock returns the reader to
 * the page they were after. The manage page never passes through here — the
 * manage secret is stronger authority than the reading password.
 */
export async function passwordGate(
  request: Request,
  row: WorkRow,
  path: string,
): Promise<Response | null> {
  if (row.password_hash === null) return null;
  if (await isUnlocked(request, row.id, row.password_hash)) return null;
  return gatePage(
    { id: row.id, title: row.title, penName: row.pen_name, lang: langForWork(row.language) },
    { next: path },
  );
}

function servePage(body: BodyInit, locked: boolean): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Locked works must never sit in a shared cache — the response depends
      // on the unlock cookie, not just the URL.
      'cache-control': locked ? 'no-store' : 'public, max-age=300',
    },
  });
}

export async function handleRead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  const row = await getActiveWork(env, id);
  if (row === null) return notFoundPage(notFoundLang(request));
  const gate = await passwordGate(request, row, `/w/${id}`);
  if (gate !== null) return gate; // gate serves never count as opens

  const obj = await env.SHELF_R2.get(pageKey(id));
  if (obj === null) return notFoundPage(notFoundLang(request));

  const ip = clientIp(request);
  ctx.waitUntil(
    (async () => {
      const cooldown = await env.RL_VIEWS.limit({ key: `${ip}:${id}` });
      if (cooldown.success) await incrementViews(env.SHELF_DB, id);
    })(),
  );

  return servePage(obj.body, row.password_hash !== null);
}

/** Chapter pages never count views — navigation within a book is one open. */
export async function handleReadChapter(
  request: Request,
  env: Env,
  id: string,
  n: number,
): Promise<Response> {
  const row = await getActiveWork(env, id);
  if (row === null) return notFoundPage(notFoundLang(request));
  const gate = await passwordGate(request, row, `/w/${id}/${n}`);
  if (gate !== null) return gate;

  const obj = await env.SHELF_R2.get(chapterKey(id, n));
  if (obj === null) return notFoundPage(notFoundLang(request));

  return servePage(obj.body, row.password_hash !== null);
}
