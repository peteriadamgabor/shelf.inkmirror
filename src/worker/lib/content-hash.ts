/**
 * Content hash for tombstones: sha256 over the bundle's block CONTENTS only,
 * joined with a single space, in (chapter order, block order).
 *
 * Deliberately blind to title, pen name, rating, warnings, marks, metadata,
 * and ids — a removed work re-uploaded under a new title with the same prose
 * still matches its tombstone. Any single character of prose changed produces
 * a different hash (a tombstone is a takedown record, not a similarity net).
 */

import type { PublishBundleV1 } from '../../format';
import { sha256Hex } from './crypto';

export async function contentHash(bundle: PublishBundleV1): Promise<string> {
  const chapterRank = new Map<string, number>();
  [...bundle.chapters]
    .sort((a, b) => a.order - b.order)
    .forEach((c, i) => chapterRank.set(c.id, i));

  const blocks = [...bundle.blocks].sort((a, b) => {
    const ra = chapterRank.get(a.chapter_id) ?? 0;
    const rb = chapterRank.get(b.chapter_id) ?? 0;
    return ra !== rb ? ra - rb : a.order - b.order;
  });

  return await sha256Hex(blocks.map((b) => b.content).join(' '));
}
