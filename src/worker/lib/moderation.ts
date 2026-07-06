/**
 * Phase 2 moderation chain — SHADOW MODE.
 *
 * Runs in the background (ctx.waitUntil) AFTER a successful publish/update:
 * the content is already stored and baked, the HTTP response has already been
 * decided. The chain observes and records; it never blocks anything, never
 * auto-rejects, never auto-publishes a hard-line suspicion (CLAUDE.md rule 5).
 * Non-pass verdicts ping Discord for a human; that is the entire enforcement
 * surface in shadow mode. Flipping shadow → gate is Phase 3's job.
 *
 * Shape:
 *   1. Chunk the prose (reading order, ~6k chars, block-id boundaries kept,
 *      hard cap 30 chunks — first 20 + a workId-seeded sample of 10).
 *   2. Router pass — claude-haiku-4-5, batches of ≤8 chunks, forced tool use
 *      → per-chunk category flags. Cheap, most works end here as 'pass'.
 *   3. Verifier pass — claude-sonnet-5, ONE call, only when a hard-line
 *      category was flagged or the aggregate flags aren't covered by the
 *      declared rating/warnings. Answers exactly two questions: hard line
 *      crossed? labels honest?
 *   4. Verdict JSON → works.moderation_verdict (+ moderation_at); silently a
 *      no-op when the row is gone (unpublished mid-run).
 *
 * Failure posture: any API error, timeout (~60s overall AbortSignal cap), or
 * parse failure becomes an {outcome:'error'} verdict. Nothing here ever
 * throws out of the waitUntil promise.
 *
 * Budget guards, three layers (plus the operator-side braces: a monthly
 * spend limit in the Anthropic console):
 *   1. per-IP rate limits on every write route (the existing outer guard);
 *   2. content-hash dedup — identical prose never pays twice (updates skip
 *      the shadow run, the listing gate reuses a fresh verdict);
 *   3. global daily run cap — settings counter chain_runs_{YYYY-MM-DD} vs
 *      env.CHAIN_DAILY_CAP, checked-and-incremented BEFORE any API call.
 *      Over budget, shadow runs record {outcome:'skipped'} and listing
 *      requests degrade to the no-key manual-review path — exhaustion never
 *      grants a listing and never blocks link-publishing.
 * Also: unset ANTHROPIC_API_KEY = complete no-op; works under 200 chars are
 * skipped; router replies are capped small; one run per publish, no retries.
 */

import {
  RATINGS,
  WARNING_TAGS,
  type PublishBundleV1,
  type Rating,
  type WarningTag,
} from '../../format';
import type { Env } from './env';
import { contentHash } from './content-hash';
import { incrementCounter, setModerationVerdict } from './db';

// Model choices (Claude API, 2026-07): claude-haiku-4-5 is the current
// small/fast tier — right for high-volume yes/no routing. claude-sonnet-5 is
// the current stronger tier below Opus — the hard-line / label call is rare
// and deserves the better judge, while Opus-class pricing would blow the
// "cents per novel" budget for no accuracy we need.
export const ROUTER_MODEL = 'claude-haiku-4-5';
export const VERIFIER_MODEL = 'claude-sonnet-5';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export const CHUNK_TARGET_CHARS = 6_000;
export const MAX_CHUNKS = 30;
export const HEAD_CHUNKS = 20;
export const SAMPLE_CHUNKS = 10;
/** Below this many prose chars there is nothing to review — skip entirely. */
export const MIN_MODERATED_CHARS = 200;

const ROUTER_BATCH = 8;
const ROUTER_MAX_TOKENS = 800; // ≤8 tiny JSON rows — keep the reply cheap
const VERIFIER_MAX_TOKENS = 1_000;
/** Verifier excerpt budget so a pathological work can't build a huge prompt. */
const VERIFIER_MAX_EXCERPT_CHUNKS = 8;
const OVERALL_TIMEOUT_MS = 60_000;

// ---------- global daily run budget ----------

export const CHAIN_DAILY_CAP_DEFAULT = 100;
export const CHAIN_DAILY_CAP_MIN = 1;
export const CHAIN_DAILY_CAP_MAX = 10_000;

/** env.CHAIN_DAILY_CAP parsed: default 100, clamped 1..10000. */
export function chainDailyCap(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return CHAIN_DAILY_CAP_DEFAULT;
  return Math.min(CHAIN_DAILY_CAP_MAX, Math.max(CHAIN_DAILY_CAP_MIN, parsed));
}

/** Settings key of the day's run counter — UTC date, so it rolls at 00:00Z. */
export function chainRunsKey(now: Date = new Date()): string {
  return `chain_runs_${now.toISOString().slice(0, 10)}`;
}

/**
 * Check-and-increment the day's run counter BEFORE any Anthropic call.
 * Returns true when this run fits the budget. The increment sticks even
 * when the run later fails — an errored attempt consumed spend, and letting
 * error loops run free would defeat the cap.
 */
export async function consumeChainBudget(env: Env): Promise<boolean> {
  const used = await incrementCounter(env.SHELF_DB, chainRunsKey());
  return used <= chainDailyCap(env.CHAIN_DAILY_CAP);
}

// ---------- verdict fingerprint ----------

/**
 * The exact artifact a verdict reviewed: content hash + rating + normalized
 * warnings. The listing gate reuses a stored verdict ONLY when this matches
 * the current bundle + labels — so a verdict earned by different content or
 * different labels can never be laundered onto the public shelf. Warnings are
 * sorted + deduped so tag order never changes the fingerprint.
 */
export function verdictFingerprint(
  contentHash: string,
  rating: string,
  warnings: readonly string[],
): string {
  const normalized = [...new Set(warnings)].sort().join(',');
  return `${contentHash}|${rating}|${normalized}`;
}

// ---------- verdict ----------

export type ModerationOutcome = 'pass' | 'tag-fix' | 'hold' | 'error' | 'skipped';

export interface ModerationVerdict {
  outcome: ModerationOutcome;
  truncated: boolean;
  flaggedChunks: number;
  suggested?: { rating: Rating; warnings: WarningTag[] };
  reason?: string;
  model: string;
  ms: number;
}

/** Lenient reader for stored verdict JSON (admin surface). */
export function parseModerationVerdict(raw: string | null): ModerationVerdict | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)['outcome'] === 'string'
    ) {
      return parsed as unknown as ModerationVerdict;
    }
  } catch {
    /* stored by us, but never trust a parse */
  }
  return null;
}

// ---------- chunking ----------

export interface ModerationChunk {
  /** Block ids this chunk covers (a >6k block is split; every slice keeps its id). */
  blockIds: string[];
  text: string;
}

/**
 * Concatenate block contents in reading order (chapter order, block order —
 * same ordering as content-hash.ts) into ~CHUNK_TARGET_CHARS chunks that
 * never cut a block in half unless the block itself is oversized.
 */
export function chunkBundle(bundle: PublishBundleV1): ModerationChunk[] {
  const chapterRank = new Map<string, number>();
  [...bundle.chapters]
    .sort((a, b) => a.order - b.order)
    .forEach((c, i) => chapterRank.set(c.id, i));

  const blocks = [...bundle.blocks].sort((a, b) => {
    const ra = chapterRank.get(a.chapter_id) ?? 0;
    const rb = chapterRank.get(b.chapter_id) ?? 0;
    return ra !== rb ? ra - rb : a.order - b.order;
  });

  const chunks: ModerationChunk[] = [];
  let ids: string[] = [];
  let parts: string[] = [];
  let len = 0;
  const flush = (): void => {
    if (parts.length > 0) {
      chunks.push({ blockIds: ids, text: parts.join('\n') });
      ids = [];
      parts = [];
      len = 0;
    }
  };

  for (const b of blocks) {
    if (b.content.length === 0) continue;
    if (b.content.length > CHUNK_TARGET_CHARS) {
      flush();
      for (let i = 0; i < b.content.length; i += CHUNK_TARGET_CHARS) {
        chunks.push({ blockIds: [b.id], text: b.content.slice(i, i + CHUNK_TARGET_CHARS) });
      }
      continue;
    }
    if (len > 0 && len + b.content.length > CHUNK_TARGET_CHARS) flush();
    ids.push(b.id);
    parts.push(b.content);
    len += b.content.length + 1;
  }
  flush();
  return chunks;
}

/** FNV-1a over the work id — a stable per-work seed, nothing cryptographic. */
function seedFromWorkId(workId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < workId.length; i++) {
    h ^= workId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG, plenty for sampling chunks. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cap at MAX_CHUNKS: the first HEAD_CHUNKS always go (openings set the tone
 * and the labels), plus SAMPLE_CHUNKS drawn from the rest with a PRNG seeded
 * by workId — deterministic per work, so a re-run reviews the same slice.
 */
export function capChunks(
  chunks: ModerationChunk[],
  workId: string,
): { chunks: ModerationChunk[]; truncated: boolean } {
  if (chunks.length <= MAX_CHUNKS) return { chunks, truncated: false };
  const head = chunks.slice(0, HEAD_CHUNKS);
  const rest = chunks.slice(HEAD_CHUNKS);
  const rand = mulberry32(seedFromWorkId(workId));
  // Partial Fisher–Yates: pick SAMPLE_CHUNKS positions of `rest`, keep reading order.
  const indices = rest.map((_, i) => i);
  const pickedIdx: number[] = [];
  for (let i = 0; i < SAMPLE_CHUNKS && i < indices.length; i++) {
    const j = i + Math.floor(rand() * (indices.length - i));
    const a = indices[i] ?? 0;
    indices[i] = indices[j] ?? 0;
    indices[j] = a;
    pickedIdx.push(indices[i] ?? 0);
  }
  pickedIdx.sort((a, b) => a - b);
  const sampled: ModerationChunk[] = [];
  for (const i of pickedIdx) {
    const c = rest[i];
    if (c !== undefined) sampled.push(c);
  }
  return { chunks: [...head, ...sampled], truncated: true };
}

// ---------- router pass ----------

export const ROUTER_FLAGS = [
  'minors',
  'real-person-harassment',
  'sexual-explicit',
  'graphic-violence',
  'self-harm',
] as const;
export type RouterFlag = (typeof ROUTER_FLAGS)[number];

const HARD_FLAGS: ReadonlySet<RouterFlag> = new Set(['minors', 'real-person-harassment']);
const FLAG_SET = new Set<string>(ROUTER_FLAGS);

const ROUTER_SYSTEM =
  'You are a content router for a fiction-publishing platform. Every text you ' +
  'see is from a work of fiction; dark themes, violence, and adult content are ' +
  'allowed and expected on this platform and are NOT flags by themselves. You ' +
  'are routing chunks for closer review, not judging them. For each numbered ' +
  'chunk, answer ONLY whether it plausibly contains: ' +
  '(a) "minors" — sexual content involving minors; ' +
  '(b) "real-person-harassment" — doxxing or targeted harassment of real, identifiable persons; ' +
  '(c) "sexual-explicit" — explicit sexual content; ' +
  '(d) "graphic-violence" — graphic violence; ' +
  '(e) "self-harm" — depiction of self-harm or suicide. ' +
  'An empty flags array means nothing needs review. Report every chunk you were given.';

const ROUTER_TOOL = {
  name: 'route_chunks',
  description:
    'Report, for every numbered chunk, which review categories plausibly appear in it. ' +
    'An empty flags array means nothing to review in that chunk.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['chunk', 'flags'],
          properties: {
            chunk: { type: 'integer', description: 'The chunk number as given.' },
            flags: { type: 'array', items: { type: 'string', enum: [...ROUTER_FLAGS] } },
          },
        },
      },
    },
  },
} as const;

// ---------- verifier pass ----------

const VERIFIER_SYSTEM =
  'You are the verification step of a fiction-publishing platform’s moderation ' +
  'chain. A cheap router flagged some excerpts of a published work of fiction for ' +
  'closer review. You answer ONLY two questions; you never judge literary merit or ' +
  'themes. Sexual and violent content is permitted on this platform when labeled; ' +
  'fiction about dark subjects is legal and welcome. ' +
  'Question 1 — hardLine: does any excerpt actually contain sexual content ' +
  'involving minors, or doxxing/targeted harassment of a real identifiable person? ' +
  'Fictional characters, fictional crimes, and non-sexual depictions of children ' +
  'are NOT hard lines. Give a one-sentence reason grounded in a short quote from ' +
  'the excerpts. ' +
  'Question 2 — labels: given the author’s DECLARED rating and warnings, are the ' +
  'labels honest for what the excerpts contain, or under-labeled? When ' +
  'under-labeled, suggest the rating and warnings that would be honest. ' +
  'Ratings: general (all ages) / mature (16+, non-explicit adult themes) / ' +
  'explicit (18+, explicit sex or violence).';

const VERIFIER_TOOL = {
  name: 'verify_work',
  description: 'Answer the two moderation questions about the flagged excerpts.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['hardLine', 'reason', 'labels', 'suggested'],
    properties: {
      hardLine: { type: 'string', enum: ['none', 'minors', 'real-person-harassment'] },
      reason: {
        type: 'string',
        description:
          'One sentence grounded in a short quote from the excerpts. Empty string when hardLine is none and labels are honest.',
      },
      labels: { type: 'string', enum: ['honest', 'under-labeled'] },
      suggested: {
        type: 'object',
        additionalProperties: false,
        required: ['rating', 'warnings'],
        description: 'The honest labels. Echo the declared labels when labels is "honest".',
        properties: {
          rating: { type: 'string', enum: [...RATINGS] },
          warnings: { type: 'array', items: { type: 'string', enum: [...WARNING_TAGS] } },
        },
      },
    },
  },
} as const;

interface VerifierAnswer {
  hardLine: 'none' | 'minors' | 'real-person-harassment';
  reason: string;
  labels: 'honest' | 'under-labeled';
  suggested: { rating: Rating; warnings: WarningTag[] };
}

// ---------- Anthropic plumbing ----------

interface ToolSpec {
  name: string;
  description: string;
  strict: boolean;
  input_schema: Record<string, unknown>;
}

/**
 * One forced-tool-use Messages call over raw fetch (no SDK in the Worker
 * bundle). Returns the tool_use input, or throws — callers translate every
 * throw into an {outcome:'error'} verdict.
 */
async function callTool(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  tool: ToolSpec,
  maxTokens: number,
  signal: AbortSignal,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      ...extra,
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${model} responded ${res.status}`);
  const data: unknown = await res.json();
  if (typeof data !== 'object' || data === null) throw new Error('anthropic reply not an object');
  const content = (data as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) throw new Error('anthropic reply has no content');
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>)['type'] === 'tool_use' &&
      (block as Record<string, unknown>)['name'] === tool.name
    ) {
      return (block as Record<string, unknown>)['input'];
    }
  }
  throw new Error(`anthropic reply carries no ${tool.name} tool_use block`);
}

function numberedChunks(chunks: ModerationChunk[], offset: number): string {
  return chunks
    .map((c, i) => `--- CHUNK ${offset + i} ---\n${c.text}`)
    .join('\n\n');
}

async function routerPass(
  apiKey: string,
  chunks: ModerationChunk[],
  signal: AbortSignal,
): Promise<RouterFlag[][]> {
  const flagsByChunk: RouterFlag[][] = chunks.map(() => []);
  for (let offset = 0; offset < chunks.length; offset += ROUTER_BATCH) {
    const batch = chunks.slice(offset, offset + ROUTER_BATCH);
    const input = await callTool(
      apiKey,
      ROUTER_MODEL,
      ROUTER_SYSTEM,
      `Chunks ${offset}–${offset + batch.length - 1} of a published work of fiction:\n\n${numberedChunks(batch, offset)}`,
      ROUTER_TOOL,
      ROUTER_MAX_TOKENS,
      signal,
    );
    if (typeof input !== 'object' || input === null) throw new Error('router reply malformed');
    const results = (input as Record<string, unknown>)['results'];
    if (!Array.isArray(results)) throw new Error('router reply missing results');
    for (const r of results) {
      if (typeof r !== 'object' || r === null) continue;
      const rec = r as Record<string, unknown>;
      const n = rec['chunk'];
      const flags = rec['flags'];
      if (typeof n !== 'number' || !Array.isArray(flags)) continue;
      if (n < offset || n >= offset + batch.length) continue; // out-of-batch index — ignore
      flagsByChunk[n] = flags.filter((f): f is RouterFlag => typeof f === 'string' && FLAG_SET.has(f));
    }
  }
  return flagsByChunk;
}

/**
 * Which aggregate content flags (c)(d)(e) the DECLARED labels do not cover.
 * This only decides whether the verifier call is worth spending — honesty
 * itself is the verifier's judgment, not this table's.
 */
export function uncoveredContentFlags(
  flags: ReadonlySet<RouterFlag>,
  rating: Rating,
  warnings: readonly WarningTag[],
): RouterFlag[] {
  const w = new Set(warnings);
  const out: RouterFlag[] = [];
  if (flags.has('sexual-explicit') && rating !== 'explicit' && !w.has('sexual-content')) {
    out.push('sexual-explicit');
  }
  if (flags.has('graphic-violence') && !w.has('graphic-violence')) out.push('graphic-violence');
  if (flags.has('self-harm') && !w.has('self-harm')) out.push('self-harm');
  return out;
}

function parseVerifierAnswer(input: unknown): VerifierAnswer {
  if (typeof input !== 'object' || input === null) throw new Error('verifier reply malformed');
  const rec = input as Record<string, unknown>;
  const hardLine = rec['hardLine'];
  const labels = rec['labels'];
  const reason = typeof rec['reason'] === 'string' ? rec['reason'] : '';
  if (hardLine !== 'none' && hardLine !== 'minors' && hardLine !== 'real-person-harassment') {
    throw new Error('verifier hardLine malformed');
  }
  if (labels !== 'honest' && labels !== 'under-labeled') throw new Error('verifier labels malformed');
  const sug = rec['suggested'];
  let suggested: VerifierAnswer['suggested'] = { rating: 'explicit', warnings: [] };
  if (typeof sug === 'object' && sug !== null) {
    const s = sug as Record<string, unknown>;
    const rating = s['rating'];
    const warnings = s['warnings'];
    suggested = {
      rating: RATINGS.includes(rating as Rating) ? (rating as Rating) : 'explicit',
      warnings: Array.isArray(warnings)
        ? warnings.filter((x): x is WarningTag => WARNING_TAGS.includes(x as WarningTag))
        : [],
    };
  }
  return { hardLine, reason, labels, suggested };
}

async function verifierPass(
  apiKey: string,
  bundle: PublishBundleV1,
  chunks: ModerationChunk[],
  flagsByChunk: RouterFlag[][],
  uncovered: RouterFlag[],
  signal: AbortSignal,
): Promise<VerifierAnswer> {
  // Hard-line chunks always travel in full; label-mismatch chunks fill the
  // remaining excerpt budget in reading order.
  const excerptIdx: number[] = [];
  flagsByChunk.forEach((flags, i) => {
    if (flags.some((f) => HARD_FLAGS.has(f))) excerptIdx.push(i);
  });
  flagsByChunk.forEach((flags, i) => {
    if (excerptIdx.length >= VERIFIER_MAX_EXCERPT_CHUNKS) return;
    if (excerptIdx.includes(i)) return;
    if (flags.some((f) => uncovered.includes(f))) excerptIdx.push(i);
  });
  excerptIdx.sort((a, b) => a - b);

  const excerpts = excerptIdx
    .slice(0, VERIFIER_MAX_EXCERPT_CHUNKS)
    .map((i) => {
      const c = chunks[i];
      const flags = flagsByChunk[i] ?? [];
      return `--- EXCERPT (chunk ${i}; router flags: ${flags.join(', ') || 'none'}) ---\n${c?.text ?? ''}`;
    })
    .join('\n\n');

  const allFlags = [...new Set(flagsByChunk.flat())];
  const user =
    `DECLARED rating: ${bundle.rating}\n` +
    `DECLARED warnings: ${bundle.warnings.join(', ') || '(none)'}\n` +
    `Aggregate router flags across the whole work: ${allFlags.join(', ') || '(none)'}\n\n` +
    `Flagged excerpts:\n\n${excerpts}`;

  const input = await callTool(
    apiKey,
    VERIFIER_MODEL,
    VERIFIER_SYSTEM,
    user,
    VERIFIER_TOOL,
    VERIFIER_MAX_TOKENS,
    signal,
    // Forced tool_choice + a tight token budget: skip thinking explicitly so
    // the reply is the tool call and nothing else.
    { thinking: { type: 'disabled' } },
  );
  return parseVerifierAnswer(input);
}

// ---------- the chain ----------

async function moderate(
  apiKey: string,
  bundle: PublishBundleV1,
  workId: string,
  signal: AbortSignal,
  started: number,
): Promise<ModerationVerdict> {
  const { chunks, truncated } = capChunks(chunkBundle(bundle), workId);
  const flagsByChunk = await routerPass(apiKey, chunks, signal);
  const flaggedChunks = flagsByChunk.filter((f) => f.length > 0).length;

  const aggregate = new Set(flagsByChunk.flat());
  const hasHard = [...aggregate].some((f) => HARD_FLAGS.has(f));
  const uncovered = uncoveredContentFlags(aggregate, bundle.rating, bundle.warnings);

  if (!hasHard && uncovered.length === 0) {
    return {
      outcome: 'pass',
      truncated,
      flaggedChunks,
      model: ROUTER_MODEL,
      ms: Date.now() - started,
    };
  }

  const answer = await verifierPass(apiKey, bundle, chunks, flagsByChunk, uncovered, signal);
  const base = {
    truncated,
    flaggedChunks,
    model: VERIFIER_MODEL,
    ms: Date.now() - started,
  };
  // hold ⇔ hardLine !== 'none'; a hold may still carry the label suggestion.
  if (answer.hardLine !== 'none') {
    return {
      outcome: 'hold',
      ...base,
      reason: answer.reason.slice(0, 500) || `hard line: ${answer.hardLine}`,
      ...(answer.labels === 'under-labeled' ? { suggested: answer.suggested } : {}),
    };
  }
  if (answer.labels === 'under-labeled') {
    return {
      outcome: 'tag-fix',
      ...base,
      suggested: answer.suggested,
      ...(answer.reason.length > 0 ? { reason: answer.reason.slice(0, 500) } : {}),
    };
  }
  return { outcome: 'pass', ...base };
}

// ---------- shadow reporting ----------

async function notifyDiscord(
  env: Env,
  workId: string,
  title: string,
  verdict: ModerationVerdict,
): Promise<void> {
  const hook = env.DISCORD_WEBHOOK;
  if (hook === undefined || hook.length === 0) return;

  const colors: Record<ModerationOutcome, number> = {
    hold: 0xd85a30, // ember
    'tag-fix': 0xd9a441, // amber
    error: 0x8a8a8a,
    pass: 0x8a8a8a,
    skipped: 0x8a8a8a, // never posted — budget skips stay out of Discord
  };
  const lines: string[] = [];
  if (verdict.reason !== undefined && verdict.reason.length > 0) lines.push(verdict.reason);
  if (verdict.suggested !== undefined) {
    lines.push(
      `Suggested labels: ${verdict.suggested.rating} [${verdict.suggested.warnings.join(', ') || 'no warnings'}]`,
    );
  }
  const body = {
    content: '**Shelf moderation (shadow)**',
    embeds: [
      {
        title: `Moderation: ${verdict.outcome}`,
        description: lines.join('\n').slice(0, 2000) || '_no detail_',
        color: colors[verdict.outcome],
        fields: [
          { name: 'Work', value: workId, inline: true },
          { name: 'Title', value: title.slice(0, 256), inline: true },
          { name: 'URL', value: `https://shelf.inkmirror.cc/w/${workId}`, inline: false },
        ],
        footer: { text: 'SHADOW MODE — nothing was blocked' },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] as string[] },
  };
  try {
    const resp = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.error(`[moderation] discord webhook failed status=${resp.status}`);
  } catch (e) {
    console.error(`[moderation] discord webhook unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- entry points ----------

/**
 * Run the chain once and return the verdict. NEVER throws: every API error,
 * timeout, or parse failure collapses into an {outcome:'error'} verdict.
 * Shared by the shadow observer (runModerationChain) and the Phase 3 listing
 * gate (src/worker/lib/listing.ts), which map the same verdict to different
 * consequences.
 */
export async function runChainVerdict(
  apiKey: string,
  bundle: PublishBundleV1,
  workId: string,
): Promise<ModerationVerdict> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS);
  try {
    return await moderate(apiKey, bundle, workId, controller.signal, started);
  } catch (e) {
    return {
      outcome: 'error',
      truncated: false,
      flaggedChunks: 0,
      reason: (e instanceof Error ? e.message : 'moderation failed').slice(0, 300),
      model: ROUTER_MODEL,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The verdict a budget-skipped shadow run records instead of calling out. */
export function budgetSkippedVerdict(): ModerationVerdict {
  return {
    outcome: 'skipped',
    truncated: false,
    flaggedChunks: 0,
    reason: 'daily budget reached',
    model: '',
    ms: 0,
  };
}

/**
 * The waitUntil body. Never rejects: every failure collapses into an
 * {outcome:'error'} verdict, and even the verdict write is defended.
 * Checks the global daily budget before spending: over budget, a 'skipped'
 * verdict is stored and nothing else happens — no API call, no Discord
 * (a daily ping-per-publish would be pure noise; the admin console carries
 * the counter).
 */
export async function runModerationChain(
  env: Env,
  apiKey: string,
  bundle: PublishBundleV1,
  workId: string,
): Promise<void> {
  const verdict = (await consumeChainBudget(env))
    ? await runChainVerdict(apiKey, bundle, workId)
    : budgetSkippedVerdict();

  // Bind the verdict to the exact artifact reviewed. The guarded write
  // (WHERE content_hash = reviewedHash) no-ops if the author updated the
  // content between scheduling and now — a late verdict never lands on
  // superseded prose.
  const reviewedHash = await contentHash(bundle);
  const fingerprint = verdictFingerprint(reviewedHash, bundle.rating, bundle.warnings);

  try {
    // Silently a no-op when the work was unpublished mid-run — the UPDATE
    // simply matches zero rows.
    await setModerationVerdict(
      env.SHELF_DB,
      workId,
      JSON.stringify(verdict),
      new Date().toISOString(),
      reviewedHash,
      fingerprint,
    );
  } catch (e) {
    console.error(`[moderation] verdict write failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Pass outcomes live in D1 only — no Discord noise for the common case,
  // and budget skips stay silent too (they'd fire on every publish all day).
  if (verdict.outcome !== 'pass' && verdict.outcome !== 'skipped') {
    await notifyDiscord(env, workId, bundle.title, verdict);
  }
}

/**
 * Called by publish/update AFTER content is stored and baked. Shadow mode:
 * the response is already decided; this only schedules the observer.
 * Complete no-op when ANTHROPIC_API_KEY is unset or the work is too small.
 */
export function scheduleModeration(
  ctx: ExecutionContext,
  env: Env,
  bundle: PublishBundleV1,
  workId: string,
  passwordProtected: boolean,
): void {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return;
  // A password-locked work is private: it cannot be listed, and its prose
  // must never be sent to a third-party model. Skip the shadow chain
  // entirely — same posture as the no-key path. When the password is later
  // removed, the next content/label change or listing request runs the chain.
  if (passwordProtected) return;
  let total = 0;
  for (const b of bundle.blocks) total += b.content.length;
  if (total < MIN_MODERATED_CHARS) return;
  ctx.waitUntil(
    runModerationChain(env, apiKey, bundle, workId).catch((e) => {
      // runModerationChain already swallows everything; this is the belt
      // to its suspenders so waitUntil can never see a rejection.
      console.error(`[moderation] unexpected: ${e instanceof Error ? e.message : String(e)}`);
    }),
  );
}
