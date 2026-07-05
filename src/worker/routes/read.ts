/**
 * GET /w/:id — serve the baked reading page from R2.
 *
 * D1 is the gatekeeper (status + expiry); R2 only stores the bytes. View
 * counting rides on ctx.waitUntil behind a per-(ip, work) cooldown so
 * serving is never blocked and refresh spam doesn't inflate "opens".
 */

import type { Env } from '../lib/env';
import { htmlResponse, pageShell } from '../../html';
import { getWork, incrementViews, pageKey } from '../lib/db';
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

export async function handleRead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  const row = await getWork(env.SHELF_DB, id);
  if (row === null || row.status !== 'active') return notFoundPage();
  const expiresMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresMs) && expiresMs < Date.now()) return notFoundPage();

  const obj = await env.SHELF_R2.get(pageKey(id));
  if (obj === null) return notFoundPage();

  const ip = clientIp(request);
  ctx.waitUntil(
    (async () => {
      const cooldown = await env.RL_VIEWS.limit({ key: `${ip}:${id}` });
      if (cooldown.success) await incrementViews(env.SHELF_DB, id);
    })(),
  );

  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
