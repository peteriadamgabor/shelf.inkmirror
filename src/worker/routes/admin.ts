/**
 * /api/admin/* — the operator toolkit (Phase 1.5). All JSON, all behind the
 * X-Admin-Secret header (src/worker/lib/admin.ts). Unauthenticated callers
 * get the same HTML 404 as an unknown route — the surface is not probeable.
 *
 *   GET    /api/admin/overview            counts, recent works/reports, held listings, pause state, tombstones
 *   GET    /api/admin/works/:id           full row (minus secret hashes) + its reports
 *   POST   /api/admin/works/:id/remove    status='removed' (+ optional tombstone); also delists
 *   POST   /api/admin/works/:id/restore   back to 'active' (only from 'removed')
 *   POST   /api/admin/works/:id/relabel   fix rating/warnings + re-bake the page
 *   POST   /api/admin/works/:id/listing   { action: 'approve' | 'deny' } a held/pending listing
 *   POST   /api/admin/works/:id/expiry    set expires_at = now + days
 *   POST   /api/admin/pause               panic switch (settings.publishing_paused)
 *   DELETE /api/admin/tombstones/:hash    forgive a tombstone
 *   GET    /api/admin/backup              download the full D1 dump as JSON
 *   POST   /api/admin/restore-db          non-destructive restore from a dump
 */

import { isPublishBundle, type PublishBundleV1 } from '../../format';
import type { Env } from '../lib/env';
import { adminAuthorized } from '../lib/admin';
import { contentHash } from '../lib/content-hash';
import {
  bundleKey,
  countWorksByStatus,
  deleteTombstone,
  getSetting,
  getWork,
  listHeldListings,
  listRecentReports,
  listRecentWorks,
  listReportsForWork,
  listTombstones,
  removeWork,
  renewWork,
  restoreWork,
  setListingResolved,
  setSetting,
  totalViews,
  upsertTombstone,
  type WorkRow,
} from '../lib/db';
import { chainDailyCap, chainRunsKey, parseModerationVerdict } from '../lib/moderation';
import { parseListingVerdict } from '../lib/listing';
import { parseLabels, relabelAndRebake } from '../lib/relabel';
import { dumpDatabase, restoreDatabase } from '../lib/backup';
import { WORK_ID_RE, clientIp, jsonError, readBodyCapped } from '../lib/http';
import { PAUSED_KEY } from './publish';
import { notFoundPage } from './read';

const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const MAX_TOMBSTONE_NOTE = 500;
const RECENT_LIMIT = 20;
const HELD_LIMIT = 50;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

export async function handleAdmin(request: Request, env: Env, path: string, method: string): Promise<Response> {
  const rl = await env.RL_MANAGE.limit({ key: clientIp(request) });
  if (!rl.success) return jsonError(429, 'rate_limited');

  // No secret configured, missing header, wrong header — all indistinguishable
  // from a route that does not exist.
  if (!(await adminAuthorized(request, env))) return notFoundPage();

  if (path === '/api/admin/overview' && method === 'GET') return await overview(env);
  if (path === '/api/admin/pause' && method === 'POST') return await pause(request, env);
  if (path === '/api/admin/backup' && method === 'GET') return await downloadBackup(env);
  if (path === '/api/admin/restore-db' && method === 'POST') return await importDatabase(request, env);

  const workMatch = path.match(/^\/api\/admin\/works\/([^/]{1,64})(?:\/(remove|restore|relabel|listing|expiry))?$/);
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
    if (action === 'listing' && method === 'POST') return await decideListing(request, env, row);
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

/** GET /api/admin/backup — the full D1 dump as a downloadable JSON file. */
async function downloadBackup(env: Env): Promise<Response> {
  const dump = await dumpDatabase(env.SHELF_DB, new Date().toISOString());
  return new Response(JSON.stringify(dump), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="shelf-backup-${dump.exported_at.slice(0, 10)}.json"`,
    },
  });
}

/**
 * POST /api/admin/restore-db — non-destructive restore from a posted dump.
 * INSERT OR IGNORE only, so it can add missing rows but never overwrite or
 * delete. Returns per-table counts.
 */
async function importDatabase(request: Request, env: Env): Promise<Response> {
  const text = await readBodyCapped(request, 64 * 1024 * 1024); // dumps can be large
  if (text === null) return jsonError(413, 'too_large');
  let dump: unknown;
  try {
    dump = JSON.parse(text);
  } catch {
    return jsonError(400, 'invalid_json');
  }
  try {
    const counts = await restoreDatabase(env.SHELF_DB, dump);
    return Response.json({ ok: true, restored: counts });
  } catch (e) {
    return jsonError(400, 'invalid_dump', e instanceof Error ? e.message : 'restore failed');
  }
}

async function overview(env: Env): Promise<Response> {
  const db = env.SHELF_DB;
  const [works, views, recentWorks, recentReports, held, paused, tombstones, chainUsed] = await Promise.all([
    countWorksByStatus(db),
    totalViews(db),
    listRecentWorks(db, RECENT_LIMIT),
    listRecentReports(db, RECENT_LIMIT),
    listHeldListings(db, HELD_LIMIT),
    getSetting(db, PAUSED_KEY),
    listTombstones(db, 100),
    getSetting(db, chainRunsKey()),
  ]);
  return Response.json({
    works,
    totalViews: views,
    // Today's chain-run spend against the global daily cap (UTC-keyed).
    chainBudget: {
      cap: chainDailyCap(env.CHAIN_DAILY_CAP),
      usedToday: chainUsed === null ? 0 : Number(chainUsed) || 0,
    },
    recentWorks,
    recentReports,
    // The operator's queue: listing requests waiting on a human decision.
    heldListings: held.map(({ listing_verdict, ...rest }) => ({
      ...rest,
      listing: parseListingVerdict(listing_verdict),
    })),
    publishingPaused: paused === '1',
    tombstones,
  });
}

async function workDetail(env: Env, row: WorkRow): Promise<Response> {
  const reports = await listReportsForWork(env.SHELF_DB, row.id, 100);
  // The manage-secret hash (and any future password hash) is the author's
  // capability material — the operator has no use for it, so it never leaves.
  // The raw verdict JSON strings are replaced by their parsed forms.
  const { secret_hash: _sh, password_hash: _ph, moderation_verdict, listing_verdict, ...safe } = row;
  return Response.json({
    work: {
      ...safe,
      moderation: parseModerationVerdict(moderation_verdict),
      listing: parseListingVerdict(listing_verdict),
    },
    reports,
  });
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
  const labels = parseLabels(body);
  if (!labels.ok) return jsonError(400, labels.error);

  // Operator authority: the moderator relabels in place — the listing (if
  // any) stands; only the cached verdict is staled inside relabelWork.
  const result = await relabelAndRebake(env, row.id, labels.rating, labels.warnings, false);
  if (!result.ok) return jsonError(409, result.error);
  return Response.json({
    ok: true,
    rating: labels.rating,
    warnings: labels.warnings,
    updated_at: result.updated_at,
  });
}

/**
 * POST /api/admin/works/:id/listing — { action: 'approve' | 'deny' } on a
 * held (or still-pending) listing request. Approve mirrors a chain pass;
 * deny lands as refused with the operator's mark, so the author's manage
 * page says who said no.
 */
async function decideListing(request: Request, env: Env, row: WorkRow): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return jsonError(400, 'invalid_body');
  const action = body['action'];
  if (action !== 'approve' && action !== 'deny') return jsonError(400, 'invalid_action');
  if (row.listing_state !== 'held' && row.listing_state !== 'pending') {
    return jsonError(409, 'no_listing_request');
  }

  if (action === 'approve') {
    const listedAt = new Date().toISOString();
    await setListingResolved(env.SHELF_DB, row.id, 'listed', listedAt, null);
    return Response.json({ ok: true, listingState: 'listed', listed_at: listedAt });
  }
  await setListingResolved(env.SHELF_DB, row.id, 'refused', null, JSON.stringify({ reason: 'operator' }));
  return Response.json({ ok: true, listingState: 'refused' });
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
