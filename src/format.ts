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
  /**
   * Optional book-cover image as a `data:image/(png|jpeg|webp);base64,…` URI,
   * downscaled by the client before publish. Shown on the gallery card and at
   * the top of the work's cover page. A new public surface: on the public
   * shelf (listed works only) it is vision-moderated at listing time; on a
   * link-shared work it rides as unmoderated plumbing, same as the prose.
   * NULL when the author set no cover.
   */
  cover_image: string | null;
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
const MAX_CHAPTER_TITLE = 500;
const MAX_CHARACTER_NAME = 200;
const MAX_SCENE_FIELD = 500;
const MAX_PARENTHETICAL = 500;
const MAX_LANGUAGE = 35;
/** Decoded cover bytes cap. The client downscales well below this (~150 KB). */
export const MAX_COVER_BYTES = 400_000;
/** The only image encodings a cover may use — all browser-native, all safe to <img>. */
const COVER_MIME_SET = new Set<string>(['image/png', 'image/jpeg', 'image/webp']);
const COVER_DATA_URI_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Validate an optional cover image. Returns the clean data URI, or null when
 * absent. THROWS on a malformed non-null value — a cover that won't decode is
 * a client bug worth failing loudly on, not silently dropping. Never runs
 * atob: the decoded length is derived from the base64 length so a hostile
 * payload can't force a huge allocation just to be rejected.
 */
export function parseCoverImage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error('cover_image must be a data URI string');
  const m = COVER_DATA_URI_RE.exec(raw);
  if (m === null) throw new Error('cover_image must be a base64 data URI (png/jpeg/webp)');
  const mime = m[1] ?? '';
  const b64 = m[2] ?? '';
  if (!COVER_MIME_SET.has(mime)) throw new Error(`cover_image mime "${mime}" not allowed`);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;
  if (bytes <= 0) throw new Error('cover_image is empty');
  if (bytes > MAX_COVER_BYTES) throw new Error('cover_image too large');
  return raw;
}

/** Split a validated cover data URI into its mime + raw bytes for R2 storage. */
export function decodeCoverImage(dataUri: string): { mime: string; bytes: Uint8Array } {
  const m = COVER_DATA_URI_RE.exec(dataUri);
  if (m === null) throw new Error('not a cover data URI');
  const mime = m[1] ?? 'image/jpeg';
  const binary = atob(m[2] ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mime, bytes };
}

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
  parseCoverImage((bundle.document as Record<string, unknown>)['cover_image']); // throws on a malformed cover
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

// ---------- sanitizer ----------
//
// The security-critical entry point. validatePublishBundle checks a shape but
// leaves the ORIGINAL object intact, so unknown fields (document.notes, an
// unstripped block field, a hostile top-level key) would be stored verbatim
// in R2. sanitizePublishBundle instead CONSTRUCTS a brand-new bundle holding
// only allowlisted, type-checked, length-capped values — nothing the client
// sent survives unless this function copied it deliberately. Publish/update
// store the RESULT, never the request body.

function capStr(x: unknown, max: number): string {
  return typeof x === 'string' ? x.slice(0, max) : '';
}

function sanitizeMarks(blockId: string, marks: unknown, contentLength: number): Mark[] | undefined {
  if (marks === undefined) return undefined;
  validateMarks(blockId, marks, contentLength);
  const out: Mark[] = (marks as Array<Record<string, unknown>>).map((m) => ({
    type: m['type'] === 'bold' ? 'bold' : 'italic',
    start: m['start'] as number,
    end: m['end'] as number,
  }));
  return out.length > 0 ? out : undefined;
}

function sanitizeMetadata(
  blockId: string,
  blockType: PublishedBlockType,
  meta: unknown,
  characterIds: Set<string>,
): PublishedBlockMetadata {
  if (!isPlainObject(meta)) throw new Error(`block "${blockId}" metadata invalid`);
  // The declared metadata.type must match the block's own type — a scene
  // body with dialogue metadata (or vice versa) is a malformed artifact.
  if (meta['type'] !== blockType) {
    throw new Error(`block "${blockId}" metadata.type does not match block type`);
  }
  if (blockType === 'text') return { type: 'text' };
  if (blockType === 'dialogue') {
    const data = meta['data'];
    if (!isPlainObject(data)) throw new Error(`block "${blockId}" dialogue data missing`);
    const rawSpeaker = data['speaker_id'];
    const speaker_id =
      typeof rawSpeaker === 'string' && (rawSpeaker === '' || characterIds.has(rawSpeaker))
        ? rawSpeaker
        : '';
    const rawParen = data['parenthetical'];
    if (typeof rawParen === 'string' && rawParen.length > 0) {
      return { type: 'dialogue', data: { speaker_id, parenthetical: rawParen.slice(0, MAX_PARENTHETICAL) } };
    }
    return { type: 'dialogue', data: { speaker_id } };
  }
  // scene
  const data = meta['data'];
  if (!isPlainObject(data)) throw new Error(`block "${blockId}" scene data missing`);
  const rawIds = Array.isArray(data['character_ids']) ? data['character_ids'] : [];
  const character_ids = rawIds.filter(
    (x): x is string => typeof x === 'string' && characterIds.has(x),
  );
  return {
    type: 'scene',
    data: {
      location: capStr(data['location'], MAX_SCENE_FIELD),
      time: capStr(data['time'], MAX_SCENE_FIELD),
      character_ids,
      mood: capStr(data['mood'], MAX_SCENE_FIELD),
    },
  };
}

/**
 * Build a clean PublishBundleV1 from untrusted input, or throw. The returned
 * object is freshly constructed — the only fields that survive are the ones
 * copied here. Duplicate ids, mismatched metadata types, and over-long
 * strings are rejected or capped. This is what the server stores.
 */
export function sanitizePublishBundle(x: unknown): PublishBundleV1 {
  if (!isPublishBundle(x)) throw new Error('not a publish bundle');
  const raw = x as unknown as Record<string, unknown>;

  const title = raw['title'];
  if (!isNonEmptyString(title) || title.length > MAX_TITLE) throw new Error('title missing or too long');
  const penName = raw['pen_name'];
  if (!isNonEmptyString(penName) || penName.length > MAX_PEN_NAME) throw new Error('pen_name missing or too long');
  const language = raw['language'];
  if (!isNonEmptyString(language) || language.length > MAX_LANGUAGE) throw new Error('language missing or invalid');
  const rating = raw['rating'];
  if (typeof rating !== 'string' || !RATING_SET.has(rating)) throw new Error('invalid rating');
  const warningsRaw = raw['warnings'];
  if (!Array.isArray(warningsRaw)) throw new Error('warnings not an array');
  const warnings: WarningTag[] = [];
  for (const w of warningsRaw) {
    if (typeof w !== 'string' || !WARNING_SET.has(w)) throw new Error(`unknown warning tag "${String(w)}"`);
    if (!warnings.includes(w as WarningTag)) warnings.push(w as WarningTag);
  }

  const doc = raw['document'];
  if (!isPlainObject(doc)) throw new Error('document missing');
  const synopsis = doc['synopsis'];
  if (typeof synopsis !== 'string' || synopsis.length > MAX_SYNOPSIS) throw new Error('document.synopsis invalid');

  const charsRaw = raw['characters'];
  if (!Array.isArray(charsRaw)) throw new Error('characters not an array');
  if (charsRaw.length > MAX_CHARACTERS) throw new Error('too many characters');
  const characterIds = new Set<string>();
  const characters: PublishedCharacter[] = charsRaw.map((c) => {
    if (!isPlainObject(c) || !isNonEmptyString(c['id'])) throw new Error('character id invalid');
    const id = c['id'];
    if (characterIds.has(id)) throw new Error(`duplicate character id "${id}"`);
    if (!isNonEmptyString(c['name'])) throw new Error(`character "${id}" name missing`);
    if (typeof c['color'] !== 'string') throw new Error(`character "${id}" color invalid`);
    // Sanitizing would silently drop these, but their PRESENCE means the
    // client failed to strip — a real bug worth failing loudly on, not hiding.
    for (const key of ['notes', 'aliases', 'description']) {
      if (key in c) throw new Error(`character "${id}" carries private field "${key}" — unstripped bundle`);
    }
    characterIds.add(id);
    return { id, name: (c['name'] as string).slice(0, MAX_CHARACTER_NAME), color: c['color'].slice(0, 32) };
  });

  const rawPov = doc['pov_character_id'];
  const pov_character_id =
    typeof rawPov === 'string' && characterIds.has(rawPov) ? rawPov : null;
  const cover_image = parseCoverImage(doc['cover_image']);

  const chaptersRaw = raw['chapters'];
  if (!Array.isArray(chaptersRaw) || chaptersRaw.length === 0) throw new Error('chapters missing or empty');
  if (chaptersRaw.length > MAX_CHAPTERS) throw new Error('too many chapters');
  const chapterIds = new Set<string>();
  const chapters: PublishedChapter[] = chaptersRaw.map((ch) => {
    if (!isPlainObject(ch) || !isNonEmptyString(ch['id'])) throw new Error('chapter id invalid');
    const id = ch['id'];
    if (chapterIds.has(id)) throw new Error(`duplicate chapter id "${id}"`);
    if (typeof ch['title'] !== 'string') throw new Error(`chapter "${id}" title invalid`);
    if (typeof ch['order'] !== 'number' || !Number.isFinite(ch['order'])) throw new Error(`chapter "${id}" order invalid`);
    if (typeof ch['kind'] !== 'string' || !KIND_SET.has(ch['kind'])) throw new Error(`chapter "${id}" has invalid kind`);
    chapterIds.add(id);
    const out: PublishedChapter = {
      id,
      title: ch['title'].slice(0, MAX_CHAPTER_TITLE),
      order: ch['order'],
      kind: ch['kind'] as ChapterKind,
    };
    if (typeof ch['export_title'] === 'boolean') out.export_title = ch['export_title'];
    return out;
  });

  const blocksRaw = raw['blocks'];
  if (!Array.isArray(blocksRaw)) throw new Error('blocks not an array');
  if (blocksRaw.length > MAX_BLOCKS) throw new Error('too many blocks');
  const blockIds = new Set<string>();
  const blocks: PublishedBlock[] = blocksRaw.map((b) => {
    if (!isPlainObject(b) || !isNonEmptyString(b['id'])) throw new Error('block id invalid');
    const id = b['id'];
    if (blockIds.has(id)) throw new Error(`duplicate block id "${id}"`);
    const type = b['type'];
    if (typeof type !== 'string' || !BLOCK_TYPE_SET.has(type)) {
      throw new Error(`block "${id}" has non-publishable type "${String(type)}"`);
    }
    // Loud failure on the known unstripped-backup signal (graveyard fields,
    // per-block timestamps) — everything else unknown is just dropped.
    for (const key of FORBIDDEN_BLOCK_KEYS) {
      if (key in b) throw new Error(`block "${id}" carries "${key}" — unstripped bundle`);
    }
    if (typeof b['content'] !== 'string' || b['content'].length > MAX_BLOCK_CONTENT) {
      throw new Error(`block "${id}" content invalid or too long`);
    }
    if (typeof b['order'] !== 'number' || !Number.isFinite(b['order'])) throw new Error(`block "${id}" order invalid`);
    if (!isNonEmptyString(b['chapter_id']) || !chapterIds.has(b['chapter_id'])) {
      throw new Error(`block "${id}" chapter_id has no matching chapter`);
    }
    blockIds.add(id);
    const content = b['content'];
    const blockType = type as PublishedBlockType;
    const out: PublishedBlock = {
      id,
      chapter_id: b['chapter_id'],
      type: blockType,
      content,
      order: b['order'],
      metadata: sanitizeMetadata(id, blockType, b['metadata'], characterIds),
    };
    const marks = sanitizeMarks(id, b['marks'], content.length);
    if (marks !== undefined) out.marks = marks;
    return out;
  });

  return {
    kind: PUBLISH_BUNDLE_KIND,
    version: PUBLISH_BUNDLE_VERSION,
    app_version: capStr(raw['app_version'], 64),
    title,
    pen_name: penName,
    language,
    rating: rating as Rating,
    warnings,
    document: { synopsis, pov_character_id, cover_image },
    chapters,
    blocks,
    characters,
  };
}
