/**
 * /api/admin/* — the operator toolkit (Phase 1.5). All JSON, all behind the
 * X-Admin-Secret header (src/worker/lib/admin.ts). Unauthenticated callers
 * get the same HTML 404 as an unknown route — the surface is not probeable.
 *
 *   GET    /api/admin/overview            counts, recent works/reports, pause state, tombstones
 *   GET    /api/admin/works/:id           full row (minus secret hashes) + its reports
 *   POST   /api/admin/works/:id/remove    status='removed' (+ optional tombstone)
 *   POST   /api/admin/works/:id/restore   back to 'active' (only from 'removed')
 *   POST   /api/admin/works/:id/relabel   fix rating/warnings + re-bake the page
 *   POST   /api/admin/works/:id/expiry    set expires_at = now + days
 *   POST   /api/admin/pause               panic switch (settings.publishing_paused)
 *   DELETE /api/admin/tombstones/:hash    forgive a tombstone
 */

import { RATINGS, WARNING_TAGS, isPublishBundle, type PublishBundleV1, type WarningTag } from '../../format';
import { renderWorkPage } from '../../render';
import type { Env } from '../lib/env';
import { adminAuthorized } from '../lib/admin';
import { contentHash } from '../lib/content-hash';
import {
  bundleKey,
  countWorksByStatus,
  deleteTombstone,
  getSetting,
  getWork,
  listRecentReports,
  listRecentWorks,
  listReportsForWork,
  listTombstones,
  pageKey,
  relabelWork,
  removeWork,
  renewWork,
  restoreWork,
  setSetting,
  totalViews,
  upsertTombstone,
  type WorkRow,
} from '../lib/db';
import { WORK_ID_RE, clientIp, jsonError, readBodyCapped } from '../lib/http';
import { PAUSED_KEY } from './publish';
import { notFoundPage } from './read';

const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const MAX_TOMBSTONE_NOTE = 500;
const RECENT_LIMIT = 20;
const RATING_SET = new Set<string>(RATINGS);
const WARNING_SET = new Set<string>(WARNING_TAGS);
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

export async function handleAdmin(request: Request, env: Env, path: string, method: string): Promise<Response> {
  const rl = await env.RL_MANAGE.limit({ key: clientIp(request) });
  if (!rl.success) return jsonError(429, 'rate_limited');

  // No secret configured, missing header, wrong header — all indistinguishable
  // from a route that does not exist.
  if (!(await adminAuthorized(request, env))) return notFoundPage();

  if (path === '/api/admin/overview' && method === 'GET') return await overview(env);
  if (path === '/api/admin/pause' && method === 'POST') return await pause(request, env);

  const workMatch = path.match(/^\/api\/admin\/works\/([^/]{1,64})(?:\/(remove|restore|relabel|expiry))?$/);
  if (workMatch) {
    const [, rawId, action] = workMatch;
    if (!WORK_ID_RE.test(rawId ?? '')) return jsonError(404, 'not_found');
    const id = rawId ?? '';
    const row = await getWork(env.SHELF_DB, id);
    if (row === null) return jsonError(404, 'not_found');
    if (action === undefined && method === 'GET') return await workDetail(env, row);
    if (action === 'remove' && method === 'POST') return await remove(request, env, row);
    if (action === 'restore' && method === 'POST') return await restore(env, row);
    if (action === 'relabel' && method === 'POST') return await relabel(request, env, row);
    if (action === 'expiry' && method === 'POST') return await setExpiry(request, env, row);
    return jsonError(405, 'method_not_allowed');
  }

  const tombMatch = path.match(/^\/api\/admin\/tombstones\/([0-9a-f]{1,128})$/);
  if (tombMatch && method === 'DELETE') {
    const hash = tombMatch[1] ?? '';
    if (!CONTENT_HASH_RE.test(hash)) return jsonError(404, 'not_found');
    await deleteTombstone(env.SHELF_DB, hash);
    return Response.json({ ok: true });
  }

  return jsonError(404, 'not_found');
}

// ---------- body plumbing ----------

/** Parse a small JSON body; an empty body reads as {}. Null = reject. */
async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await readBodyCapped(request, MAX_ADMIN_BODY_BYTES);
  if (text === null) return null;
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

async function loadBundle(env: Env, id: string): Promise<PublishBundleV1 | null> {
  const obj = await env.SHELF_R2.get(bundleKey(id));
  if (obj === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await obj.text());
  } catch {
    return null;
  }
  return isPublishBundle(parsed) ? parsed : null;
}

// ---------- routes ----------

async function overview(env: Env): Promise<Response> {
  const db = env.SHELF_DB;
  const [works, views, recentWorks, recentReports, paused, tombstones] = await Promise.all([
    countWorksByStatus(db),
    totalViews(db),
    listRecentWorks(db, RECENT_LIMIT),
    listRecentReports(db, RECENT_LIMIT),
    getSetting(db, PAUSED_KEY),
    listTombstones(db, 100),
  ]);
  return Response.json({
    works,
    totalViews: views,
    recentWorks,
    recentReports,
    publishingPaused: paused === '1',
    tombstones,
  });
}

async function workDetail(env: Env, row: WorkRow): Promise<Response> {
  const reports = await listReportsForWork(env.SHELF_DB, row.id, 100);
  // The manage-secret hash (and any future password hash) is the author's
  // capability material — the operator has no use for it, so it never leaves.
  const { secret_hash: _sh, password_hash: _ph, ...safe } = row;
  return Response.json({ work: safe, reports });
}

async function remove(request: Request, env: Env, row: WorkRow): Promise<Response> {
  if (row.status === 'removed') return jsonError(409, 'already_removed');
  const body = await readJsonBody(request);
  if (body === null) return jsonError(400, 'invalid_body');

  const nowIso = new Date().toISOString();
  let tombstoned = false;
  if (body['tombstone'] === true) {
    const noteRaw = body['note'];
    const note = typeof noteRaw === 'string' ? noteRaw.slice(0, MAX_TOMBSTONE_NOTE) : '';
    const bundle = await loadBundle(env, row.id);
    if (bundle !== null) {
      await upsertTombstone(env.SHELF_DB, {
        content_hash: await contentHash(bundle),
        work_title: row.title,
        created_at: nowIso,
        note,
      });
      tombstoned = true;
    }
  }

  await removeWork(env.SHELF_DB, row.id, nowIso);
  return Response.json({ ok: true, tombstoned, removed_at: nowIso });
}

async function restore(env: Env, row: WorkRow): Promise<Response> {
  if (row.status !== 'removed') return jsonError(409, 'not_removed');
  await restoreWork(env.SHELF_DB, row.id);
  return Response.json({ ok: true });
}

async function relabel(request: Request, env: Env, row: WorkRow): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return jsonError(400, 'invalid_body');

  const rating = body['rating'];
  if (typeof rating !== 'string' || !RATING_SET.has(rating)) return jsonError(400, 'invalid_rating');
  const warningsRaw = body['warnings'];
  if (!Array.isArray(warningsRaw)) return jsonError(400, 'invalid_warnings');
  const warnings: WarningTag[] = [];
  for (const w of warningsRaw) {
    if (typeof w !== 'string' || !WARNING_SET.has(w)) return jsonError(400, 'invalid_warnings');
    if (!warnings.includes(w as WarningTag)) warnings.push(w as WarningTag);
  }

  const bundle = await loadBundle(env, row.id);
  if (bundle === null) return jsonError(409, 'bundle_missing');

  bundle.rating = rating as PublishBundleV1['rating'];
  bundle.warnings = warnings;
  const html = renderWorkPage(bundle, { id: row.id });

  await env.SHELF_R2.put(bundleKey(row.id), JSON.stringify(bundle), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.SHELF_R2.put(pageKey(row.id), html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });

  const updatedAt = new Date().toISOString();
  await relabelWork(env.SHELF_DB, row.id, rating, warnings, updatedAt);
  return Response.json({ ok: true, rating, warnings, updated_at: updatedAt });
}

async function setExpiry(request: Request, env: Env, row: WorkRow): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return jsonError(400, 'invalid_body');
  const days = body['days'];
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
    return jsonError(400, 'invalid_days');
  }
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await renewWork(env.SHELF_DB, row.id, expiresAt);
  return Response.json({ ok: true, expires_at: expiresAt });
}

async function pause(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return jsonError(400, 'invalid_body');
  const paused = body['paused'];
  if (typeof paused !== 'boolean') return jsonError(400, 'invalid_paused');
  await setSetting(env.SHELF_DB, PAUSED_KEY, paused ? '1' : '0');
  return Response.json({ ok: true, paused });
}
