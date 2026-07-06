/**
 * Authenticated manage surface: GET (meta) / PUT (re-bake) / DELETE
 * (unpublish) on /api/works/:id, plus POST .../renew, PUT .../password,
 * GET .../letters, DELETE .../letters/:letterId, PUT .../letters-open.
 *
 * Auth = X-Manage-Secret header, sha256'd and compared constant-time against
 * the stored hash. A wrong secret and a nonexistent id return the SAME 404
 * so work ids are never confirmable by probing. The manage secret is
 * stronger authority than the reading password — no manage route ever
 * passes the password gate.
 */

import { isPublishBundle, validatePublishBundle } from '../../format';
import { countWords, firstLine } from '../../render';
import type { Env } from '../lib/env';
import { constantTimeEqualHex, sha256Hex } from '../lib/crypto';
import { bakeWork, deleteWorkObjects } from '../lib/bake';
import {
  deleteLetter,
  deleteWork,
  getWork,
  listLetters,
  renewWork,
  setLettersOpen,
  setPasswordHash,
  updateWork,
  type WorkRow,
} from '../lib/db';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
} from '../lib/password';
import { MAX_PUBLISH_BODY_BYTES, clientIp, jsonError, readBodyCapped } from '../lib/http';
import { LETTERS_PER_WORK_CAP } from './letters';
import { WORK_TTL_MS, publishGates, workUrl } from './publish';

const MAX_SMALL_BODY_BYTES = 16 * 1024;

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
    passwordProtected: row.password_hash !== null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    url: workUrl(row.id),
  });
}

export type ManageAction =
  | 'meta'
  | 'update'
  | 'unpublish'
  | 'renew'
  | 'password'
  | 'letters'
  | 'letters-open'
  | 'letter-delete';

export async function handleManage(
  request: Request,
  env: Env,
  id: string,
  action: ManageAction,
  letterId?: string,
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
    case 'password':
      return await setPassword(request, env, row);
    case 'letters': {
      const letters = await listLetters(env.SHELF_DB, row.id, LETTERS_PER_WORK_CAP);
      return Response.json({ lettersOpen: row.letters_open === 1, letters });
    }
    case 'letters-open':
      return await lettersOpen(request, env, row);
    case 'letter-delete':
      await deleteLetter(env.SHELF_DB, row.id, letterId ?? '');
      return Response.json({ ok: true });
  }
}

/** Small JSON object body for the settings-style routes; null = reject. */
async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await readBodyCapped(request, MAX_SMALL_BODY_BYTES);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * PUT /api/works/:id/password — body { password: string | null }.
 * A string sets/changes the gate (PBKDF2-SHA256, fresh salt); null clears
 * it. Either way the unlock-cookie HMAC key rotates, signing every reader
 * out — no session cleanup needed.
 */
async function setPassword(request: Request, env: Env, row: WorkRow): Promise<Response> {
  const body = await readSmallJson(request);
  if (body === null || !('password' in body)) return jsonError(400, 'invalid_body');

  const password = body['password'];
  if (password === null) {
    await setPasswordHash(env.SHELF_DB, row.id, null);
    return Response.json({ ok: true, passwordProtected: false });
  }
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return jsonError(400, 'invalid_password');
  }
  await setPasswordHash(env.SHELF_DB, row.id, await hashPassword(password));
  return Response.json({ ok: true, passwordProtected: true });
}

/** PUT /api/works/:id/letters-open — body { open: boolean }. */
async function lettersOpen(request: Request, env: Env, row: WorkRow): Promise<Response> {
  const body = await readSmallJson(request);
  if (body === null) return jsonError(400, 'invalid_body');
  const open = body['open'];
  if (typeof open !== 'boolean') return jsonError(400, 'invalid_open');
  await setLettersOpen(env.SHELF_DB, row.id, open);
  return Response.json({ ok: true, lettersOpen: open });
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
