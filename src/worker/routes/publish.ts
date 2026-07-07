/**
 * POST /api/publish — validate, bake, store.
 *
 * Never trust the client: the full bundle re-runs validatePublishBundle
 * (which rejects anything smelling of an unstripped backup — graveyard
 * fields, note blocks, private character fields) before a single byte
 * touches R2 or D1.
 */

import { isPublishBundle, sanitizePublishBundle, type PublishBundleV1 } from '../../format';
import { countWords, firstLine } from '../../render';
import type { Env } from '../lib/env';
import { randomBase64Url, sha256Hex } from '../lib/crypto';
import { contentHash } from '../lib/content-hash';
import { bakeWork } from '../lib/bake';
import { getSetting, hasTombstone, insertWork } from '../lib/db';
import { scheduleModeration } from '../lib/moderation';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword } from '../lib/password';
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
 * Takes the bundle's precomputed content hash — the caller stores the same
 * hash on the row (moderation dedup), so it is only ever computed once.
 * Returns the error response, or null when the gates are open.
 */
export async function publishGates(env: Env, bundleHash: string): Promise<Response | null> {
  if ((await getSetting(env.SHELF_DB, PAUSED_KEY)) === '1') {
    return Response.json(
      { error: 'publishing_paused', message: 'The Shelf is temporarily closed for new works.' },
      { status: 503 },
    );
  }
  if (await hasTombstone(env.SHELF_DB, bundleHash)) {
    return jsonError(403, 'not_acceptable');
  }
  return null;
}

export async function handlePublish(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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
  // Sanitize into a freshly constructed bundle: ONLY allowlisted, type-checked,
  // length-capped fields survive — nothing the client sent reaches R2 unless
  // sanitizePublishBundle copied it deliberately. Everything downstream uses
  // `clean`, never the raw request body.
  let clean: PublishBundleV1;
  try {
    clean = sanitizePublishBundle(parsed);
  } catch (e) {
    return jsonError(400, 'invalid_bundle', e instanceof Error ? e.message : 'validation failed');
  }

  // Optional publish-time password: an author can lock a work from the first
  // byte (private beta-reader drafts), rather than publishing unprotected and
  // locking afterward. It rides as a top-level request field, extracted here
  // and NOT part of the bundle — sanitizePublishBundle already dropped it, so
  // it never reaches R2. A locked work is private: it skips the moderation
  // chain entirely (see below) and cannot be listed.
  const rawPassword = (parsed as unknown as Record<string, unknown>)['password'];
  let passwordHash: string | null = null;
  if (rawPassword !== undefined && rawPassword !== null) {
    if (
      typeof rawPassword !== 'string' ||
      rawPassword.length < MIN_PASSWORD_LENGTH ||
      rawPassword.length > MAX_PASSWORD_LENGTH
    ) {
      return jsonError(400, 'invalid_password');
    }
    passwordHash = await hashPassword(rawPassword);
  }

  // Computed once: the tombstone gate checks it, the row stores it (the
  // moderation chain's dedup key — see migrations/0006_budget.sql).
  const bundleHash = await contentHash(clean);
  const gate = await publishGates(env, bundleHash);
  if (gate !== null) return gate;

  const id = randomBase64Url(16); // 22 chars — the capability for unlisted works
  const manageSecret = randomBase64Url(32);
  const secretHash = await sha256Hex(manageSecret);

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + WORK_TTL_MS).toISOString();

  const coverMime = await bakeWork(clean, id, env);

  await insertWork(env.SHELF_DB, {
    id,
    secret_hash: secretHash,
    title: clean.title,
    pen_name: clean.pen_name,
    language: clean.language,
    rating: clean.rating,
    warnings: clean.warnings,
    word_count: countWords(clean),
    first_line: firstLine(clean),
    content_hash: bundleHash,
    created_at: nowIso,
    updated_at: nowIso,
    expires_at: expiresAt,
    password_hash: passwordHash,
    cover_mime: coverMime,
  });

  // Phase 2 shadow chain: content is already stored and baked — the chain
  // only observes in the background. No-op without ANTHROPIC_API_KEY. A
  // publish-time password makes the work private, so the chain is skipped
  // (a locked draft is never sent to the model).
  scheduleModeration(ctx, env, clean, id, passwordHash !== null);

  return Response.json(
    { id, url: workUrl(id), manageSecret, passwordProtected: passwordHash !== null },
    { status: 200 },
  );
}
