import { describe, expect, it } from 'vitest';
import {
  PUBLISH_BUNDLE_KIND,
  PUBLISH_BUNDLE_VERSION,
  isPublishBundle,
  validatePublishBundle,
  type PublishBundleV1,
} from './format';

function minimalBundle(): PublishBundleV1 {
  return {
    kind: PUBLISH_BUNDLE_KIND,
    version: PUBLISH_BUNDLE_VERSION,
    app_version: '0.11.3',
    title: 'A Tükör',
    pen_name: 'Á. Péteri',
    language: 'hu',
    rating: 'general',
    warnings: [],
    document: { synopsis: '', pov_character_id: null },
    chapters: [{ id: 'ch1', title: 'Egy', order: 0, kind: 'standard' }],
    blocks: [
      {
        id: 'b1',
        chapter_id: 'ch1',
        type: 'text',
        content: 'Két szív, egy lélek.',
        order: 0,
        metadata: { type: 'text' },
      },
    ],
    characters: [],
  };
}

describe('isPublishBundle', () => {
  it('accepts the envelope', () => {
    expect(isPublishBundle(minimalBundle())).toBe(true);
  });
  it('rejects a backup-bundle envelope', () => {
    expect(isPublishBundle({ kind: 'inkmirror.document', version: 1 })).toBe(false);
  });
});

describe('validatePublishBundle', () => {
  it('passes a minimal valid bundle', () => {
    expect(() => validatePublishBundle(minimalBundle())).not.toThrow();
  });

  it('rejects note blocks (non-publishable by contract)', () => {
    const b = minimalBundle();
    // @ts-expect-error deliberately violating the wire contract
    b.blocks[0].type = 'note';
    expect(() => validatePublishBundle(b)).toThrow(/non-publishable/);
  });

  it('rejects blocks carrying graveyard fields (unstripped backup)', () => {
    const b = minimalBundle();
    (b.blocks[0] as unknown as Record<string, unknown>).deleted_at = null;
    expect(() => validatePublishBundle(b)).toThrow(/unstripped/);
  });

  it('rejects characters carrying private fields', () => {
    const b = minimalBundle();
    b.characters.push({ id: 'c1', name: 'Anna', color: '#7F77DD' });
    (b.characters[0] as unknown as Record<string, unknown>).notes = 'secret';
    expect(() => validatePublishBundle(b)).toThrow(/private field/);
  });

  it('rejects unknown warning tags', () => {
    const b = minimalBundle();
    (b.warnings as unknown as string[]).push('spicy');
    expect(() => validatePublishBundle(b)).toThrow(/unknown warning tag/);
  });

  it('rejects dialogue speakers with no matching character', () => {
    const b = minimalBundle();
    b.blocks.push({
      id: 'b2',
      chapter_id: 'ch1',
      type: 'dialogue',
      content: 'Ki vagy te?',
      order: 1,
      metadata: { type: 'dialogue', data: { speaker_id: 'ghost' } },
    });
    expect(() => validatePublishBundle(b)).toThrow(/no matching character/);
  });

  it('rejects mark ranges outside the content', () => {
    const b = minimalBundle();
    b.blocks[0]!.marks = [{ type: 'bold', start: 0, end: 9999 }];
    expect(() => validatePublishBundle(b)).toThrow(/mark range/);
  });
});
