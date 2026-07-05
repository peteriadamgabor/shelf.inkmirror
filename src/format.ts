/**
 * PublishBundleV1 — the wire contract between InkMirror (client) and the
 * Shelf (server). This file is CANONICAL; InkMirror vendors a copy of the
 * types in its `src/publish/format.ts`. Breaking changes bump `version`.
 *
 * The shape is deliberately slimmer than InkMirror's `DocumentBundleV1`:
 * publishing is not backup. By contract this bundle NEVER carries:
 *   - soft-deleted blocks (the graveyard is private),
 *   - `note` blocks (writer's margin notes),
 *   - sentiments / block revisions (writer telemetry),
 *   - per-row created_at/updated_at timestamps (writing-cadence telemetry),
 *   - character aliases / notes / descriptions (only display needs travel).
 *
 * The client strips before sending; the server validates the stripped shape
 * and rejects anything that smells like an unstripped backup bundle. Never
 * trust the client to have filtered.
 */

export const PUBLISH_BUNDLE_KIND = 'inkmirror.published';
export const PUBLISH_BUNDLE_VERSION = 1;

export const RATINGS = ['general', 'mature', 'explicit'] as const;
export type Rating = (typeof RATINGS)[number];

/** Fixed warning vocabulary — author-checked at publish time. */
export const WARNING_TAGS = [
  'graphic-violence',
  'sexual-content',
  'sexual-violence',
  'self-harm',
  'child-abuse-depiction',
  'substance-abuse',
  'other',
] as const;
export type WarningTag = (typeof WARNING_TAGS)[number];

export const CHAPTER_KINDS = [
  'standard',
  'cover',
  'dedication',
  'epigraph',
  'acknowledgments',
  'afterword',
] as const;
export type ChapterKind = (typeof CHAPTER_KINDS)[number];

/** `note` is intentionally absent — non-publishable by contract. */
export type PublishedBlockType = 'text' | 'dialogue' | 'scene';

export interface Mark {
  type: 'bold' | 'italic';
  start: number;
  end: number;
}

export interface DialogueMetadata {
  /** '' = unassigned speaker (renders as plain dialogue). */
  speaker_id: string;
  parenthetical?: string;
}

export interface SceneMetadata {
  location: string;
  time: string;
  character_ids: string[];
  mood: string;
}

export type PublishedBlockMetadata =
  | { type: 'text' }
  | { type: 'dialogue'; data: DialogueMetadata }
  | { type: 'scene'; data: SceneMetadata };

export interface PublishedBlock {
  id: string;
  chapter_id: string;
  type: PublishedBlockType;
  content: string;
  marks?: Mark[];
  order: number;
  metadata: PublishedBlockMetadata;
}

export interface PublishedChapter {
  id: string;
  title: string;
  order: number;
  kind: ChapterKind;
  /** Unset = follow the kind's default (see InkMirror exporters). */
  export_title?: boolean;
}

/** Slim display shape — aliases, notes, descriptions stay home. */
export interface PublishedCharacter {
  id: string;
  name: string;
  /** Hex tag color for dialogue pills. */
  color: string;
}

export interface PublishedDocument {
  synopsis: string;
  /** Dialogue from this character renders right-aligned ("me" vs "them"). */
  pov_character_id: string | null;
}

export interface PublishBundleV1 {
  kind: typeof PUBLISH_BUNDLE_KIND;
  version: typeof PUBLISH_BUNDLE_VERSION;
  app_version: string;
  title: string;
  pen_name: string;
  /** BCP-47-ish primary tag; drives page chrome language ('en', 'hu', …). */
  language: string;
  rating: Rating;
  warnings: WarningTag[];
  document: PublishedDocument;
  chapters: PublishedChapter[];
  blocks: PublishedBlock[];
  characters: PublishedCharacter[];
}

// ---------- validation ----------
//
// Same philosophy as InkMirror's backup validator: envelope guard first,
// then deep structural + referential checks with hard row caps so a
// hostile payload cannot exhaust the Worker during the walk.

const MAX_TITLE = 300;
const MAX_PEN_NAME = 120;
const MAX_SYNOPSIS = 5_000;
const MAX_CHAPTERS = 2_000;
const MAX_BLOCKS = 100_000;
const MAX_CHARACTERS = 2_000;
const MAX_BLOCK_CONTENT = 50_000;

const RATING_SET = new Set<string>(RATINGS);
const WARNING_SET = new Set<string>(WARNING_TAGS);
const KIND_SET = new Set<string>(CHAPTER_KINDS);
const BLOCK_TYPE_SET = new Set<string>(['text', 'dialogue', 'scene']);

/** Fields whose presence marks an unstripped backup bundle. */
const FORBIDDEN_BLOCK_KEYS = ['deleted_at', 'deleted_from', 'created_at', 'updated_at'];

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

export function isPublishBundle(x: unknown): x is PublishBundleV1 {
  return (
    isPlainObject(x) &&
    x.kind === PUBLISH_BUNDLE_KIND &&
    x.version === PUBLISH_BUNDLE_VERSION
  );
}

/**
 * Throws with a descriptive message on the first violation. Call before
 * anything touches R2/D1. The strip rules are enforced here, not assumed.
 */
export function validatePublishBundle(bundle: PublishBundleV1): void {
  if (!isNonEmptyString(bundle.title) || bundle.title.length > MAX_TITLE) {
    throw new Error('title missing or too long');
  }
  if (!isNonEmptyString(bundle.pen_name) || bundle.pen_name.length > MAX_PEN_NAME) {
    throw new Error('pen_name missing or too long');
  }
  if (!isNonEmptyString(bundle.language) || bundle.language.length > 35) {
    throw new Error('language missing or invalid');
  }
  if (!RATING_SET.has(bundle.rating)) throw new Error('invalid rating');
  if (!Array.isArray(bundle.warnings)) throw new Error('warnings not an array');
  for (const w of bundle.warnings) {
    if (!WARNING_SET.has(w)) throw new Error(`unknown warning tag "${String(w)}"`);
  }

  if (!isPlainObject(bundle.document)) throw new Error('document missing');
  if (typeof bundle.document.synopsis !== 'string' || bundle.document.synopsis.length > MAX_SYNOPSIS) {
    throw new Error('document.synopsis invalid');
  }

  if (!Array.isArray(bundle.chapters) || bundle.chapters.length === 0) {
    throw new Error('chapters missing or empty');
  }
  if (bundle.chapters.length > MAX_CHAPTERS) throw new Error('too many chapters');
  if (!Array.isArray(bundle.blocks)) throw new Error('blocks not an array');
  if (bundle.blocks.length > MAX_BLOCKS) throw new Error('too many blocks');
  if (!Array.isArray(bundle.characters)) throw new Error('characters not an array');
  if (bundle.characters.length > MAX_CHARACTERS) throw new Error('too many characters');

  const characterIds = new Set<string>();
  for (const c of bundle.characters) {
    if (!isPlainObject(c) || !isNonEmptyString(c.id)) throw new Error('character id invalid');
    if (!isNonEmptyString(c.name)) throw new Error(`character "${c.id}" name missing`);
    if (typeof c.color !== 'string') throw new Error(`character "${c.id}" color invalid`);
    for (const key of ['notes', 'aliases', 'description']) {
      if (key in c) throw new Error(`character "${c.id}" carries private field "${key}" — unstripped bundle`);
    }
    characterIds.add(c.id);
  }

  const pov = bundle.document.pov_character_id;
  if (pov !== null && (!isNonEmptyString(pov) || !characterIds.has(pov))) {
    throw new Error('pov_character_id has no matching character');
  }

  const chapterIds = new Set<string>();
  for (const ch of bundle.chapters) {
    if (!isPlainObject(ch) || !isNonEmptyString(ch.id)) throw new Error('chapter id invalid');
    if (typeof ch.title !== 'string') throw new Error(`chapter "${ch.id}" title invalid`);
    if (typeof ch.order !== 'number') throw new Error(`chapter "${ch.id}" order invalid`);
    if (typeof ch.kind !== 'string' || !KIND_SET.has(ch.kind)) {
      throw new Error(`chapter "${ch.id}" has invalid kind`);
    }
    chapterIds.add(ch.id);
  }

  for (const b of bundle.blocks) {
    if (!isPlainObject(b) || !isNonEmptyString(b.id)) throw new Error('block id invalid');
    if (typeof b.type !== 'string' || !BLOCK_TYPE_SET.has(b.type)) {
      throw new Error(`block "${b.id}" has non-publishable type "${String(b.type)}"`);
    }
    for (const key of FORBIDDEN_BLOCK_KEYS) {
      if (key in b) throw new Error(`block "${b.id}" carries "${key}" — unstripped bundle`);
    }
    if (typeof b.content !== 'string' || b.content.length > MAX_BLOCK_CONTENT) {
      throw new Error(`block "${b.id}" content invalid or too long`);
    }
    if (typeof b.order !== 'number') throw new Error(`block "${b.id}" order invalid`);
    if (!isNonEmptyString(b.chapter_id) || !chapterIds.has(b.chapter_id)) {
      throw new Error(`block "${b.id}" chapter_id has no matching chapter`);
    }
    validateBlockMetadata(b.id, b.metadata, characterIds);
    validateMarks(b.id, b.marks, (b.content as string).length);
  }
}

function validateBlockMetadata(
  blockId: string,
  meta: unknown,
  characterIds: Set<string>,
): void {
  if (!isPlainObject(meta)) throw new Error(`block "${blockId}" metadata invalid`);
  const t = meta.type;
  if (t === 'text') return;
  if (t === 'dialogue') {
    const data = meta.data;
    if (!isPlainObject(data)) throw new Error(`block "${blockId}" dialogue data missing`);
    const speaker = data.speaker_id;
    if (speaker !== '' && (typeof speaker !== 'string' || !characterIds.has(speaker))) {
      throw new Error(`block "${blockId}" speaker_id has no matching character`);
    }
    return;
  }
  if (t === 'scene') {
    const data = meta.data;
    if (!isPlainObject(data)) throw new Error(`block "${blockId}" scene data missing`);
    const ids = data.character_ids;
    if (!Array.isArray(ids)) throw new Error(`block "${blockId}" scene character_ids invalid`);
    for (const id of ids) {
      if (typeof id !== 'string' || !characterIds.has(id)) {
        throw new Error(`block "${blockId}" scene character_id has no matching character`);
      }
    }
    return;
  }
  throw new Error(`block "${blockId}" metadata type "${String(t)}" not publishable`);
}

function validateMarks(blockId: string, marks: unknown, contentLength: number): void {
  if (marks === undefined) return;
  if (!Array.isArray(marks)) throw new Error(`block "${blockId}" marks not an array`);
  for (const m of marks) {
    if (!isPlainObject(m)) throw new Error(`block "${blockId}" mark not an object`);
    if (m.type !== 'bold' && m.type !== 'italic') {
      throw new Error(`block "${blockId}" mark has unknown type`);
    }
    const { start, end } = m as { start: unknown; end: unknown };
    if (
      typeof start !== 'number' || typeof end !== 'number' ||
      !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || end > contentLength || start >= end
    ) {
      throw new Error(`block "${blockId}" mark range invalid`);
    }
  }
}
