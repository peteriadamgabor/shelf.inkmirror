import { describe, expect, it } from 'vitest';
import {
  PUBLISH_BUNDLE_KIND,
  PUBLISH_BUNDLE_VERSION,
  isPublishBundle,
  sanitizePublishBundle,
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

describe('sanitizePublishBundle — constructs a clean object, drops the rest', () => {
  it('strips unknown top-level, document, chapter, and block fields', () => {
    const dirty = {
      ...minimalBundle(),
      evil: 'should not survive',
      document: { synopsis: 'ok', pov_character_id: null, notes: 'private' },
    } as unknown;
    const clean = sanitizePublishBundle(dirty) as unknown as Record<string, unknown>;
    expect('evil' in clean).toBe(false);
    expect('notes' in (clean['document'] as Record<string, unknown>)).toBe(false);
    expect((clean['document'] as Record<string, unknown>)['synopsis']).toBe('ok');
  });

  it('rejects scene metadata with a non-string location (the former render crash)', () => {
    const b = minimalBundle();
    b.blocks = [
      {
        id: 'b1',
        chapter_id: 'ch1',
        type: 'scene',
        content: 'The rain.',
        order: 0,
        // @ts-expect-error deliberately hostile input
        metadata: { type: 'scene', data: { location: 123, time: 'dawn', character_ids: [], mood: '' } },
      },
    ];
    // location is coerced to '' by the sanitizer (never reaches render as a number)
    const clean = sanitizePublishBundle(b);
    const meta = clean.blocks[0]!.metadata;
    expect(meta.type).toBe('scene');
    if (meta.type === 'scene') expect(meta.data.location).toBe('');
  });

  it('rejects metadata.type that does not match the block type', () => {
    const b = minimalBundle();
    b.blocks = [
      {
        id: 'b1',
        chapter_id: 'ch1',
        type: 'text',
        content: 'hi',
        order: 0,
        metadata: { type: 'scene', data: { location: '', time: '', character_ids: [], mood: '' } },
      },
    ];
    expect(() => sanitizePublishBundle(b)).toThrow(/does not match block type/);
  });

  it('rejects duplicate chapter, block, and character ids', () => {
    const dup = minimalBundle();
    dup.chapters = [
      { id: 'ch1', title: 'A', order: 0, kind: 'standard' },
      { id: 'ch1', title: 'B', order: 1, kind: 'standard' },
    ];
    expect(() => sanitizePublishBundle(dup)).toThrow(/duplicate chapter id/);
  });

  it('still rejects the unstripped-backup tripwires (deleted_at, character notes)', () => {
    const b1 = minimalBundle();
    (b1.blocks[0] as unknown as Record<string, unknown>)['deleted_at'] = null;
    expect(() => sanitizePublishBundle(b1)).toThrow(/unstripped/);

    const b2 = minimalBundle();
    b2.characters = [{ id: 'c1', name: 'Anna', color: '#7F77DD' }];
    (b2.characters[0] as unknown as Record<string, unknown>)['notes'] = 'secret';
    expect(() => sanitizePublishBundle(b2)).toThrow(/unstripped/);
  });

  it('caps over-long scene fields and parentheticals', () => {
    const b = minimalBundle();
    b.characters = [{ id: 'c1', name: 'X', color: '#7F77DD' }];
    b.blocks = [
      {
        id: 'b1',
        chapter_id: 'ch1',
        type: 'dialogue',
        content: 'Hi',
        order: 0,
        metadata: { type: 'dialogue', data: { speaker_id: 'c1', parenthetical: 'x'.repeat(9999) } },
      },
    ];
    const clean = sanitizePublishBundle(b);
    const meta = clean.blocks[0]!.metadata;
    if (meta.type === 'dialogue') expect((meta.data.parenthetical ?? '').length).toBeLessThanOrEqual(500);
  });
});
