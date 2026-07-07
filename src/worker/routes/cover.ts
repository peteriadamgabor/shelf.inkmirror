/**
 * GET /w/:id/cover — serve the author's cover image bytes straight from R2.
 *
 * Same gatekeeping as the reading pages: the row must be active + unexpired,
 * and a password-locked work's cover is private too — no valid unlock cookie
 * → 404 (never the gate page; an <img> can't render a form, and a 404 leaks
 * nothing). Covers never count as opens. Missing cover → 404.
 */

import type { Env } from '../lib/env';
import { coverKey } from '../lib/db';
import { isUnlocked } from '../lib/password';
import { getActiveWork } from './read';

const NOT_FOUND = new Response(null, { status: 404 });

export async function handleCover(request: Request, env: Env, id: string): Promise<Response> {
  const row = await getActiveWork(env, id);
  if (row === null) return NOT_FOUND.clone();

  // A locked work's cover is as private as its prose.
  if (row.password_hash !== null && !(await isUnlocked(request, row.id, row.password_hash))) {
    return NOT_FOUND.clone();
  }

  const obj = await env.SHELF_R2.get(coverKey(id));
  if (obj === null) return NOT_FOUND.clone();

  const locked = row.password_hash !== null;
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
      // Immutable per publish; a re-bake with a new cover changes the bytes but
      // the URL is stable, so cap the TTL. Locked covers stay out of shared caches.
      'cache-control': locked ? 'no-store' : 'public, max-age=3600',
    },
  });
}
