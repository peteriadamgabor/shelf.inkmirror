/**
 * Shared bake pipeline. POST publish, PUT update, and admin relabel all go
 * through bakeWork() so every path produces identical R2 output: the bundle,
 * the index page (single page or cover), one page per body chapter — and no
 * stale chapter pages when a re-push shrinks the chapter count (12 → 9 must
 * not leave /w/:id/10 serving).
 *
 * deleteWorkObjects() is the counterpart: unpublish and the purge cron
 * evaporate the whole works/{id}/ prefix by listing, not by fixed keys.
 */

import type { PublishBundleV1 } from '../../format';
import { renderWorkPages } from '../../render';
import type { Env } from './env';
import { bundleKey, chapterKey, chapterPrefix, pageKey, workPrefix } from './db';

const HTML_META = { httpMetadata: { contentType: 'text/html; charset=utf-8' } };
const JSON_META = { httpMetadata: { contentType: 'application/json' } };

/** R2 bulk delete takes at most 1000 keys per call. */
const R2_DELETE_BATCH = 1000;

async function listKeys(r2: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await r2.list({ prefix, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    if (!page.truncated) return keys;
    cursor = page.cursor;
  }
}

async function deleteKeys(r2: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    await r2.delete(keys.slice(i, i + R2_DELETE_BATCH));
  }
}

/** Render all pages for the bundle, write them to R2, drop stale chapters. */
export async function bakeWork(bundle: PublishBundleV1, id: string, env: Env): Promise<void> {
  const pages = renderWorkPages(bundle, { id });

  await env.SHELF_R2.put(bundleKey(id), JSON.stringify(bundle), JSON_META);
  await env.SHELF_R2.put(pageKey(id), pages.index, HTML_META);

  const current = new Set<string>();
  for (let n = 1; n <= pages.chapters.length; n++) {
    const key = chapterKey(id, n);
    current.add(key);
    await env.SHELF_R2.put(key, pages.chapters[n - 1] ?? '', HTML_META);
  }

  const stale = (await listKeys(env.SHELF_R2, chapterPrefix(id))).filter((k) => !current.has(k));
  if (stale.length > 0) await deleteKeys(env.SHELF_R2, stale);
}

/** Delete every R2 object a work owns (bundle, index, all chapter pages). */
export async function deleteWorkObjects(r2: R2Bucket, id: string): Promise<void> {
  const keys = await listKeys(r2, workPrefix(id));
  if (keys.length > 0) await deleteKeys(r2, keys);
}

/**
 * The distinct work ids that have objects under `works/` in R2, up to `limit`.
 * Used by the daily cron's orphan sweep to find R2 objects whose D1 row is
 * gone (a partial-failure leftover). Uses the delimiter so one entry comes
 * back per work, not per object.
 */
export async function listWorkIds(r2: R2Bucket, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  while (ids.length < limit) {
    const page = await r2.list({ prefix: 'works/', delimiter: '/', cursor });
    for (const p of page.delimitedPrefixes) {
      // p is `works/{id}/` — pull out the id.
      const id = p.slice('works/'.length, -1);
      if (id.length > 0) ids.push(id);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return ids.slice(0, limit);
}
