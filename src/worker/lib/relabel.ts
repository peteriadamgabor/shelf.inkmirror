/**
 * Shared re-label machinery: validate rating/warnings against the fixed
 * vocabularies, mutate the stored bundle, re-bake every page, update D1.
 *
 * Two callers, two authorities:
 *   - the operator (POST /api/admin/works/:id/relabel, X-Admin-Secret),
 *   - the author (PUT /api/works/:id/labels, X-Manage-Secret) — Phase 3's
 *     "accept the gate's suggested labels & retry" flow.
 */

import {
  RATINGS,
  WARNING_TAGS,
  isPublishBundle,
  type PublishBundleV1,
  type Rating,
  type WarningTag,
} from '../../format';
import type { Env } from './env';
import { bakeWork } from './bake';
import { bundleKey, relabelWork } from './db';

const RATING_SET = new Set<string>(RATINGS);
const WARNING_SET = new Set<string>(WARNING_TAGS);

export type LabelParse =
  | { ok: true; rating: Rating; warnings: WarningTag[] }
  | { ok: false; error: 'invalid_rating' | 'invalid_warnings' };

/** Validate a { rating, warnings } body against the fixed vocabularies. */
export function parseLabels(body: Record<string, unknown>): LabelParse {
  const rating = body['rating'];
  if (typeof rating !== 'string' || !RATING_SET.has(rating)) {
    return { ok: false, error: 'invalid_rating' };
  }
  const warningsRaw = body['warnings'];
  if (!Array.isArray(warningsRaw)) return { ok: false, error: 'invalid_warnings' };
  const warnings: WarningTag[] = [];
  for (const w of warningsRaw) {
    if (typeof w !== 'string' || !WARNING_SET.has(w)) {
      return { ok: false, error: 'invalid_warnings' };
    }
    if (!warnings.includes(w as WarningTag)) warnings.push(w as WarningTag);
  }
  return { ok: true, rating: rating as Rating, warnings };
}

export type RelabelResult =
  | { ok: true; updated_at: string }
  | { ok: false; error: 'bundle_missing' };

/** Mutate the stored bundle's labels, re-bake all pages, update the row. */
export async function relabelAndRebake(
  env: Env,
  id: string,
  rating: Rating,
  warnings: WarningTag[],
): Promise<RelabelResult> {
  const obj = await env.SHELF_R2.get(bundleKey(id));
  if (obj === null) return { ok: false, error: 'bundle_missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await obj.text());
  } catch {
    return { ok: false, error: 'bundle_missing' };
  }
  if (!isPublishBundle(parsed)) return { ok: false, error: 'bundle_missing' };

  const bundle: PublishBundleV1 = parsed;
  bundle.rating = rating;
  bundle.warnings = warnings;
  await bakeWork(bundle, id, env);

  const updatedAt = new Date().toISOString();
  await relabelWork(env.SHELF_DB, id, rating, warnings, updatedAt);
  return { ok: true, updated_at: updatedAt };
}
