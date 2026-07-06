/**
 * POST /api/publish — validate, bake, store.
 *
 * Never trust the client: the full bundle re-runs validatePublishBundle
 * (which rejects anything smelling of an unstripped backup — graveyard
 * fields, note blocks, private character fields) before a single byte
 * touches R2 or D1.
 */

import { isPublishBundle, validatePublishBundle, type PublishBundleV1 } from '../../format';
import { countWords, firstLine } from '../../render';
import type { Env } from '../lib/env';
import { randomBase64Url, sha256Hex } from '../lib/crypto';
import { contentHash } from '../lib/content-hash';
import { bakeWork } from '../lib/bake';
import { getSetting, hasTombstone, insertWork } from '../lib/db';
import { MAX_PUBLISH_BODY_BYTES, clientIp, jsonError, readBodyCapped } from '../lib/http';

export const WORK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const PAUSED_KEY = 'publishing_paused';

export function workUrl(id: string): string {
  return `https://shelf.inkmirror.cc/w/${id}`;
}

/**
 * Operator gates, checked after validation and before any R2/D1 write, on
 * both first publish and update:
 *   - panic switch: settings.publishing_paused = '1' → 503 with a human
 *     message InkMirror can surface as-is;
 *   - tombstones: content matching a removed work's hash → flat 403 with no
 *     detail (no oracle for someone probing what exactly got them removed).
 * Returns the error response, or null when the gates are open.
 */
export async function publishGates(env: Env, bundle: PublishBundleV1): Promise<Response | null> {
  if ((await getSetting(env.SHELF_DB, PAUSED_KEY)) === '1') {
    return Response.json(
      { error: 'publishing_paused', message: 'The Shelf is temporarily closed for new works.' },
      { status: 503 },
    );
  }
  if (await hasTombstone(env.SHELF_DB, await contentHash(bundle))) {
    return jsonError(403, 'not_acceptable');
  }
  return null;
}

export async function handlePublish(request: Request, env: Env): Promise<Response> {
  const rl = await env.RL_PUBLISH.limit({ key: clientIp(request) });
  if (!rl.success) return jsonError(429, 'rate_limited');

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

  const gate = await publishGates(env, parsed);
  if (gate !== null) return gate;

  const id = randomBase64Url(16); // 22 chars — the capability for unlisted works
  const manageSecret = randomBase64Url(32);
  const secretHash = await sha256Hex(manageSecret);

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + WORK_TTL_MS).toISOString();

  await bakeWork(parsed, id, env);

  await insertWork(env.SHELF_DB, {
    id,
    secret_hash: secretHash,
    title: parsed.title,
    pen_name: parsed.pen_name,
    language: parsed.language,
    rating: parsed.rating,
    warnings: parsed.warnings,
    word_count: countWords(parsed),
    first_line: firstLine(parsed),
    created_at: nowIso,
    updated_at: nowIso,
    expires_at: expiresAt,
  });

  return Response.json({ id, url: workUrl(id), manageSecret }, { status: 200 });
}
