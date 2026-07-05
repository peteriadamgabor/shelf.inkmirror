import { describe, expect, it } from 'vitest';
import { PUBLISH_BUNDLE_KIND, PUBLISH_BUNDLE_VERSION, type PublishBundleV1 } from '../../format';
import { contentHash } from './content-hash';

function bundle(overrides: Partial<PublishBundleV1> = {}): PublishBundleV1 {
  return {
    kind: PUBLISH_BUNDLE_KIND,
    version: PUBLISH_BUNDLE_VERSION,
    app_version: '0.11.3',
    title: 'A Quiet Book',
    pen_name: 'Á. Péteri',
    language: 'en',
    rating: 'general',
    warnings: [],
    document: { synopsis: '', pov_character_id: null },
    chapters: [
      { id: 'ch1', title: 'One', order: 0, kind: 'standard' },
      { id: 'ch2', title: 'Two', order: 1, kind: 'standard' },
    ],
    blocks: [
      { id: 'b1', chapter_id: 'ch1', type: 'text', content: 'First words.', order: 0, metadata: { type: 'text' } },
      { id: 'b2', chapter_id: 'ch1', type: 'text', content: 'Second thought.', order: 1, metadata: { type: 'text' } },
      { id: 'b3', chapter_id: 'ch2', type: 'text', content: 'Later on.', order: 0, metadata: { type: 'text' } },
    ],
    characters: [],
    ...overrides,
  };
}

describe('contentHash', () => {
  it('is a 64-char hex sha256', async () => {
    expect(await contentHash(bundle())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores title, pen name, rating, warnings — a re-upload in disguise still matches', async () => {
    const a = await contentHash(bundle());
    const b = await contentHash(
      bundle({
        title: 'Totally Different Title',
        pen_name: 'Somebody Else',
        rating: 'explicit',
        warnings: ['sexual-content'],
      }),
    );
    expect(b).toBe(a);
  });

  it('changes when a single character of prose changes', async () => {
    const a = await contentHash(bundle());
    const edited = bundle();
    const block = edited.blocks[1];
    if (block === undefined) throw new Error('fixture broken');
    block.content = 'Second thoughT.';
    expect(await contentHash(edited)).not.toBe(a);
  });

  it('is stable against array shuffling — order comes from (chapter order, block order)', async () => {
    const a = await contentHash(bundle());
    const shuffled = bundle();
    shuffled.blocks = [shuffled.blocks[2], shuffled.blocks[0], shuffled.blocks[1]].filter(
      (b): b is NonNullable<typeof b> => b !== undefined,
    );
    shuffled.chapters = [shuffled.chapters[1], shuffled.chapters[0]].filter(
      (c): c is NonNullable<typeof c> => c !== undefined,
    );
    expect(await contentHash(shuffled)).toBe(a);
  });

  it('ignores block ids and marks', async () => {
    const a = await contentHash(bundle());
    const renamed = bundle();
    for (const b of renamed.blocks) {
      b.id = `renamed-${b.id}`;
      b.marks = [{ type: 'bold', start: 0, end: 3 }];
    }
    expect(await contentHash(renamed)).toBe(a);
  });
});
