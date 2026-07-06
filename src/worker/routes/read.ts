/**
 * GET /w/:id — serve the baked cover/single page from R2.
 * GET /w/:id/:n — serve baked chapter page n (multi-chapter works).
 *
 * D1 is the gatekeeper (status + expiry, one shared guard for both routes);
 * R2 only stores the bytes. View counting rides on ctx.waitUntil behind a
 * per-(ip, work) cooldown so serving is never blocked and refresh spam
 * doesn't inflate "opens" — and it happens ONLY on the cover route: paging
 * through a book is one open, not twelve.
 */

import type { Env } from '../lib/env';
import { htmlResponse, pageShell } from '../../html';
import { chapterKey, getWork, incrementViews, pageKey, type WorkRow } from '../lib/db';
import { clientIp } from '../lib/http';

export function notFoundPage(): Response {
  return htmlResponse(
    pageShell({
      title: 'Not found — The Shelf',
      body: `<div class="page">
<h1>Nothing on this shelf</h1>
<p class="muted">This work doesn&#39;t exist, was unpublished by its author, or its link expired.
Unlisted links live for 30 days unless the author renews them.</p>
<p><a class="btn" href="/">The Shelf</a></p>
</div>`,
    }),
    404,
  );
}

/**
 * The one reader-facing gate: the row must exist, be active, and be inside
 * its expiry window. Cover, chapter, and report pages all pass through here.
 */
export async function getActiveWork(env: Env, id: string): Promise<WorkRow | null> {
  const row = await getWork(env.SHELF_DB, id);
  if (row === null || row.status !== 'active') return null;
  const expiresMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresMs) && expiresMs < Date.now()) return null;
  return row;
}

function servePage(body: BodyInit): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

export async function handleRead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  if ((await getActiveWork(env, id)) === null) return notFoundPage();

  const obj = await env.SHELF_R2.get(pageKey(id));
  if (obj === null) return notFoundPage();

  const ip = clientIp(request);
  ctx.waitUntil(
    (async () => {
      const cooldown = await env.RL_VIEWS.limit({ key: `${ip}:${id}` });
      if (cooldown.success) await incrementViews(env.SHELF_DB, id);
    })(),
  );

  return servePage(obj.body);
}

/** Chapter pages never count views — navigation within a book is one open. */
export async function handleReadChapter(env: Env, id: string, n: number): Promise<Response> {
  if ((await getActiveWork(env, id)) === null) return notFoundPage();

  const obj = await env.SHELF_R2.get(chapterKey(id, n));
  if (obj === null) return notFoundPage();

  return servePage(obj.body);
}
