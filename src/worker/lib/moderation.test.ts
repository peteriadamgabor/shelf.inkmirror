import { describe, expect, it } from 'vitest';
import {
  CHUNK_TARGET_CHARS,
  HEAD_CHUNKS,
  MAX_CHUNKS,
  SAMPLE_CHUNKS,
  capChunks,
  chunkBundle,
  parseModerationVerdict,
  uncoveredContentFlags,
  type ModerationChunk,
  type RouterFlag,
} from './moderation';
import {
  PUBLISH_BUNDLE_KIND,
  PUBLISH_BUNDLE_VERSION,
  type PublishBundleV1,
  type PublishedBlock,
} from '../../format';

function bundleWith(blocks: PublishedBlock[], chapters?: PublishBundleV1['chapters']): PublishBundleV1 {
  return {
    kind: PUBLISH_BUNDLE_KIND,
    version: PUBLISH_BUNDLE_VERSION,
    app_version: '0.0.0-test',
    title: 'Chunk Test',
    pen_name: 'Tester',
    language: 'en',
    rating: 'general',
    warnings: [],
    document: { synopsis: '', pov_character_id: null },
    chapters: chapters ?? [{ id: 'ch1', title: 'One', order: 0, kind: 'standard' }],
    blocks,
    characters: [],
  };
}

function textBlock(id: string, chapterId: string, order: number, content: string): PublishedBlock {
  return { id, chapter_id: chapterId, type: 'text', content, order, metadata: { type: 'text' } };
}

describe('moderation chunking', () => {
  it('concatenates blocks in reading order and keeps block-id boundaries', () => {
    const bundle = bundleWith(
      [
        // Deliberately out of array order: chapter 2 block first.
        textBlock('b3', 'c2', 0, 'third'),
        textBlock('b2', 'c1', 1, 'second'),
        textBlock('b1', 'c1', 0, 'first'),
      ],
      [
        { id: 'c1', title: 'One', order: 0, kind: 'standard' },
        { id: 'c2', title: 'Two', order: 1, kind: 'standard' },
      ],
    );
    const chunks = chunkBundle(bundle);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('first\nsecond\nthird');
    expect(chunks[0]?.blockIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('closes a chunk near the target size instead of splitting a small block', () => {
    const a = 'a'.repeat(4000);
    const b = 'b'.repeat(4000);
    const bundle = bundleWith([textBlock('b1', 'ch1', 0, a), textBlock('b2', 'ch1', 1, b)]);
    const chunks = chunkBundle(bundle);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.blockIds).toEqual(['b1']);
    expect(chunks[1]?.blockIds).toEqual(['b2']);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
  });

  it('splits an oversized block into slices that all carry its id', () => {
    const big = 'x'.repeat(CHUNK_TARGET_CHARS * 2 + 100);
    const bundle = bundleWith([textBlock('huge', 'ch1', 0, big)]);
    const chunks = chunkBundle(bundle);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(c.blockIds).toEqual(['huge']);
    expect(chunks.map((c) => c.text).join('')).toBe(big);
  });

  it('skips empty blocks', () => {
    const bundle = bundleWith([textBlock('e', 'ch1', 0, ''), textBlock('b', 'ch1', 1, 'words')]);
    const chunks = chunkBundle(bundle);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.blockIds).toEqual(['b']);
  });
});

describe('moderation chunk cap', () => {
  const many = (n: number): ModerationChunk[] =>
    Array.from({ length: n }, (_, i) => ({ blockIds: [`b${i}`], text: `chunk ${i}` }));

  it('leaves small works untouched, truncated=false', () => {
    const { chunks, truncated } = capChunks(many(MAX_CHUNKS), 'workid');
    expect(chunks).toHaveLength(MAX_CHUNKS);
    expect(truncated).toBe(false);
  });

  it('caps at MAX_CHUNKS: first HEAD_CHUNKS + SAMPLE_CHUNKS from the rest, truncated=true', () => {
    const input = many(80);
    const { chunks, truncated } = capChunks(input, 'workid');
    expect(truncated).toBe(true);
    expect(chunks).toHaveLength(MAX_CHUNKS);
    // Head is always the literal first HEAD_CHUNKS.
    for (let i = 0; i < HEAD_CHUNKS; i++) {
      expect(chunks[i]?.blockIds).toEqual([`b${i}`]);
    }
    // The sample comes from the rest, no duplicates.
    const tail = chunks.slice(HEAD_CHUNKS);
    expect(tail).toHaveLength(SAMPLE_CHUNKS);
    const seen = new Set<string>();
    for (const c of tail) {
      const id = c.blockIds[0] ?? '';
      expect(Number(id.slice(1))).toBeGreaterThanOrEqual(HEAD_CHUNKS);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('sampling is seeded by workId — same work, same sample', () => {
    const input = many(200);
    const first = capChunks(input, 'AAAAAAAAAAAAAAAAAAAAAA');
    const second = capChunks(input, 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(first.chunks.map((c) => c.blockIds[0])).toEqual(second.chunks.map((c) => c.blockIds[0]));
    // A different work id draws a different sample (with 180 candidates the
    // odds of an accidental identical draw are effectively zero).
    const other = capChunks(input, 'ZZZZZZZZZZZZZZZZZZZZZZ');
    expect(other.chunks.map((c) => c.blockIds[0])).not.toEqual(first.chunks.map((c) => c.blockIds[0]));
  });
});

describe('uncoveredContentFlags', () => {
  const flags = (...f: RouterFlag[]): Set<RouterFlag> => new Set(f);

  it('explicit rating covers sexual-explicit', () => {
    expect(uncoveredContentFlags(flags('sexual-explicit'), 'explicit', [])).toEqual([]);
  });

  it('declared warnings cover their flags', () => {
    expect(
      uncoveredContentFlags(flags('graphic-violence', 'self-harm'), 'general', [
        'graphic-violence',
        'self-harm',
      ]),
    ).toEqual([]);
  });

  it('reports flags the labels do not cover', () => {
    expect(uncoveredContentFlags(flags('sexual-explicit', 'graphic-violence'), 'general', [])).toEqual([
      'sexual-explicit',
      'graphic-violence',
    ]);
  });

  it('hard-line flags are not label questions', () => {
    expect(uncoveredContentFlags(flags('minors', 'real-person-harassment'), 'general', [])).toEqual([]);
  });
});

describe('parseModerationVerdict', () => {
  it('parses a stored verdict', () => {
    const v = parseModerationVerdict('{"outcome":"pass","truncated":false,"flaggedChunks":0,"model":"m","ms":1}');
    expect(v?.outcome).toBe('pass');
  });

  it('returns null for NULL, malformed JSON, and shapeless objects', () => {
    expect(parseModerationVerdict(null)).toBeNull();
    expect(parseModerationVerdict('not json')).toBeNull();
    expect(parseModerationVerdict('{"no":"outcome"}')).toBeNull();
  });
});
