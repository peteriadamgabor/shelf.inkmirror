/**
 * Authenticated manage surface: GET (meta) / PUT (re-bake) / DELETE
 * (unpublish) on /api/works/:id, plus POST /api/works/:id/renew.
 *
 * Auth = X-Manage-Secret header, sha256'd and compared constant-time against
 * the stored hash. A wrong secret and a nonexistent id return the SAME 404
 * so work ids are never confirmable by probing.
 */

import { isPublishBundle, validatePublishBundle } from '../../format';
import { countWords, firstLine } from '../../render';
import type { Env } from '../lib/env';
import { constantTimeEqualHex, sha256Hex } from '../lib/crypto';
import { bakeWork, deleteWorkObjects } from '../lib/bake';
import { deleteWork, getWork, renewWork, updateWork, type WorkRow } from '../lib/db';
import { MAX_PUBLISH_BODY_BYTES, clientIp, jsonError, readBodyCapped } from '../lib/http';
import { WORK_TTL_MS, publishGates, workUrl } from './publish';

/** The one 404 every unauthenticated/unknown case returns. */
function notFound(): Response {
  return jsonError(404, 'not_found');
}

/**
 * Resolve the work IFF the caller holds the manage secret. Both the missing
 * row and the wrong secret collapse into null — the caller must answer 404.
 */
async function authenticate(request: Request, env: Env, id: string): Promise<WorkRow | null> {
  const secret = request.headers.get('x-manage-secret');
  const row = await getWork(env.SHELF_DB, id);
  if (secret === null || secret.length === 0 || secret.length > 128 || row === null) return null;
  const hash = await sha256Hex(secret);
  return constantTimeEqualHex(hash, row.secret_hash) ? row : null;
}

function parseWarnings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

function metaJson(row: WorkRow): Response {
  return Response.json({
    title: row.title,
    rating: row.rating,
    warnings: parseWarnings(row.warnings),
    views: row.views,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    url: workUrl(row.id),
  });
}

export async function handleManage(
  request: Request,
  env: Env,
  id: string,
  action: 'meta' | 'update' | 'unpublish' | 'renew',
): Promise<Response> {
  const rl = await env.RL_MANAGE.limit({ key: clientIp(request) });
  if (!rl.success) return jsonError(429, 'rate_limited');

  const row = await authenticate(request, env, id);
  if (row === null) return notFound();

  switch (action) {
    case 'meta':
      return metaJson(row);
    case 'update':
      return await update(request, env, row);
    case 'unpublish':
      return await unpublish(env, id);
    case 'renew': {
      const expiresAt = new Date(Date.now() + WORK_TTL_MS).toISOString();
      await renewWork(env.SHELF_DB, id, expiresAt);
      return Response.json({ ok: true, expires_at: expiresAt });
    }
  }
}

async function update(request: Request, env: Env, row: WorkRow): Promise<Response> {
  const text = await readBodyCapped(request, MAX_PUBLISH_BODY_BYTES);
  if (text === null) return jsonError(413, 'too_large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonError(400, 'invalid_json');
  }
  if (!isPublishBundle(parsed)) return jsonError(400, 'not_a_publish_bundle');
  try {
    validatePublishBundle(parsed);
  } catch (e) {
    return jsonError(400, 'invalid_bundle', e instanceof Error ? e.message : 'validation failed');
  }

  // Updates pass the same operator gates as first publishes — a tombstoned
  // text must not slip back in as an "update" to an unrelated work.
  const gate = await publishGates(env, parsed);
  if (gate !== null) return gate;

  await bakeWork(parsed, row.id, env);

  const updatedAt = new Date().toISOString();
  await updateWork(env.SHELF_DB, row.id, {
    title: parsed.title,
    rating: parsed.rating,
    warnings: parsed.warnings,
    word_count: countWords(parsed),
    first_line: firstLine(parsed),
    updated_at: updatedAt,
  });

  return Response.json({ ok: true, id: row.id, url: workUrl(row.id), updated_at: updatedAt });
}

async function unpublish(env: Env, id: string): Promise<Response> {
  // The whole works/{id}/ prefix — chapter pages included, however many.
  await deleteWorkObjects(env.SHELF_R2, id);
  await deleteWork(env.SHELF_DB, id);
  return Response.json({ ok: true });
}
