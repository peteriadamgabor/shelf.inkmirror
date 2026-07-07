/**
 * Phase 3 listing gate. Where Phase 2's chain observes (shadow), this is the
 * chain as a HARD GATE — but only for the public shelf (design D6): unlisted
 * link-shares still skip moderation entirely.
 *
 * Flow: the author's PUT /api/works/:id/listing { list: true } sets
 * listing_state = 'pending' and schedules runListingGate via ctx.waitUntil.
 * The gate re-runs the Phase 2 chain against the STORED bundle (never the
 * request body) and maps the verdict:
 *
 *   pass    → listed (listed = 1, listed_at = now) + Discord info embed
 *   tag-fix → refused, verdict { reason: 'labels', suggested } — author-facing,
 *             no Discord (the author fixes labels and retries, no human needed)
 *   hold    → held, verdict { reason: 'review' } + Discord "needs your decision";
 *             the work stays readable by link, it is just not listed
 *   error   → held, verdict { reason: 'error' } + Discord — FAIL SAFE: a broken
 *             chain never grants a listing, a human decides
 *
 * No ANTHROPIC_API_KEY → every request goes 'held' with { reason: 'manual' }
 * and a Discord "manual review" embed; the operator approves/denies from the
 * admin console. CLAUDE.md rule 5 holds throughout: the chain may pass or
 * suggest, but a hard-line suspicion is always a human's call.
 *
 * Budget guards (see moderation.ts): when the stored verdict is a real chain
 * outcome (pass/tag-fix/hold — never error/skipped) AND the stored
 * content_hash matches the current bundle, the gate REUSES it — the mapped
 * listing_verdict records { reused: true } and no API call happens.
 * Otherwise the run is charged against the global daily cap; over budget,
 * requests degrade to the no-key manual path — budget exhaustion never
 * grants a listing and never blocks link-publishing.
 *
 * Every gate write is guarded on listing_state = 'pending' (see
 * resolveListingPending) — an author who delists or unpublishes mid-run wins
 * against a slow chain, and the Discord ping is skipped with the write.
 */

import { isPublishBundle, type PublishBundleV1, type Rating, type WarningTag } from '../../format';
import type { Env } from './env';
import { contentHash } from './content-hash';
import {
  consumeChainBudget,
  coverToken,
  parseModerationVerdict,
  runChainVerdict,
  verdictFingerprint,
  type ModerationVerdict,
} from './moderation';
import {
  bundleKey,
  getWork,
  resolveListingPending,
  setModerationVerdict,
} from './db';

// ---------- author-facing verdict ----------

/**
 * `reused: true` marks a decision made from the stored verdict of an earlier
 * chain run whose content hash still matches — no new API call was spent.
 * The bare `{ reused: true }` form is the listed case, which otherwise
 * stores no verdict at all.
 */
export type ListingVerdict =
  | { reason: 'labels'; suggested?: { rating: Rating; warnings: WarningTag[] }; reused?: true }
  | { reason: 'review'; reused?: true }
  | { reason: 'truncated'; reused?: true }
  | { reason: 'error' }
  | { reason: 'manual' }
  | { reason: 'operator' }
  | { reused: true };

const LISTING_REASONS = new Set(['labels', 'review', 'truncated', 'error', 'manual', 'operator']);

/** Lenient reader for stored listing_verdict JSON (manage meta + admin). */
export function parseListingVerdict(raw: string | null): ListingVerdict | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (
        (typeof rec['reason'] === 'string' && LISTING_REASONS.has(rec['reason'])) ||
        rec['reused'] === true
      ) {
        return parsed as ListingVerdict;
      }
    }
  } catch {
    /* stored by us, but never trust a parse */
  }
  return null;
}

// ---------- Discord (operator visibility) ----------

interface ListingEmbed {
  title: string;
  description: string;
  color: number;
  footer: string;
}

const COLOR_VIOLET = 0x7f77dd; // listed — informational
const COLOR_EMBER = 0xd85a30; // held — needs a decision
const COLOR_AMBER = 0xd9a441; // manual / error — needs a decision, no alarm

async function notifyListingDiscord(
  env: Env,
  workId: string,
  workTitle: string,
  embed: ListingEmbed,
): Promise<void> {
  const hook = env.DISCORD_WEBHOOK;
  if (hook === undefined || hook.length === 0) return;
  const body = {
    content: '**Shelf listing**',
    embeds: [
      {
        title: embed.title,
        description: embed.description.slice(0, 2000) || '_no detail_',
        color: embed.color,
        fields: [
          { name: 'Work', value: workId, inline: true },
          { name: 'Title', value: workTitle.slice(0, 256), inline: true },
          { name: 'URL', value: `https://shelf.inkmirror.cc/w/${workId}`, inline: false },
        ],
        footer: { text: embed.footer },
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
    if (!resp.ok) console.error(`[listing] discord webhook failed status=${resp.status}`);
  } catch (e) {
    console.error(`[listing] discord webhook unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- the gate ----------

async function loadStoredBundle(env: Env, id: string): Promise<PublishBundleV1 | null> {
  const obj = await env.SHELF_R2.get(bundleKey(id));
  if (obj === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await obj.text());
  } catch {
    return null;
  }
  return isPublishBundle(parsed) ? parsed : null;
}

/**
 * Resolve the pending request, then re-read the row: the guarded UPDATE
 * matched only if the request was still pending, and Discord must stay
 * silent when it didn't (the author delisted mid-run — nothing happened).
 */
async function resolveAndConfirm(
  env: Env,
  id: string,
  state: 'listed' | 'refused' | 'held',
  listedAt: string | null,
  verdict: ListingVerdict | null,
): Promise<boolean> {
  await resolveListingPending(
    env.SHELF_DB,
    id,
    state,
    listedAt,
    verdict === null ? null : JSON.stringify(verdict),
  );
  const after = await getWork(env.SHELF_DB, id);
  return after !== null && after.listing_state === state;
}

/**
 * The waitUntil body for a listing request. Never rejects; every failure
 * lands as a 'held' with reason 'error' — the fail-safe direction is always
 * "a human decides", never "a broken chain grants a listing".
 */
export async function runListingGate(env: Env, workId: string): Promise<void> {
  try {
    const row = await getWork(env.SHELF_DB, workId);
    if (row === null || row.listing_state !== 'pending') return; // withdrawn/unpublished already

    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      // Documented fallback: no key = no chain, every request is a human call.
      if (await resolveAndConfirm(env, workId, 'held', null, { reason: 'manual' })) {
        await notifyListingDiscord(env, workId, row.title, {
          title: 'LISTING REQUEST — manual review',
          description:
            'No ANTHROPIC_API_KEY is configured, so the listing gate cannot run. ' +
            'Approve or deny from the admin console.',
          color: COLOR_AMBER,
          footer: 'The work stays readable by link; it is NOT listed until you decide.',
        });
      }
      return;
    }

    const bundle = await loadStoredBundle(env, workId);
    if (bundle === null) {
      // R2 lost the bundle under us — treat exactly like a chain failure.
      if (await resolveAndConfirm(env, workId, 'held', null, { reason: 'error' })) {
        await notifyListingDiscord(env, workId, row.title, {
          title: 'LISTING HELD — bundle unreadable',
          description: 'The stored bundle could not be loaded for review.',
          color: COLOR_AMBER,
          footer: 'Fail safe: a human decides — a broken gate never lists.',
        });
      }
      return;
    }

    // Verdict reuse: a stored verdict is reused ONLY when its fingerprint
    // (content hash + rating + normalized warnings) exactly matches the
    // current artifact. This is the fix for the laundering hole — an
    // update-then-list can no longer ride a verdict earned by different
    // content or different labels, because the fingerprint won't match. A
    // reused error/skipped is never reused (a broken run is not an
    // observation).
    const currentHash = await contentHash(bundle);
    const currentFingerprint = verdictFingerprint(
      currentHash,
      bundle.rating,
      bundle.warnings,
      await coverToken(bundle),
    );
    const stored = parseModerationVerdict(row.moderation_verdict);
    const reused =
      stored !== null &&
      row.verdict_fingerprint !== null &&
      row.verdict_fingerprint === currentFingerprint &&
      (stored.outcome === 'pass' || stored.outcome === 'tag-fix' || stored.outcome === 'hold');

    let verdict: ModerationVerdict;
    if (reused && stored !== null) {
      verdict = stored;
    } else {
      // Fresh run — charged against the global daily budget. Over budget the
      // request degrades to the exact no-key posture: held, a human decides.
      // Budget exhaustion must NEVER grant a listing.
      if (!(await consumeChainBudget(env))) {
        if (await resolveAndConfirm(env, workId, 'held', null, { reason: 'manual' })) {
          await notifyListingDiscord(env, workId, row.title, {
            title: 'LISTING REQUEST — manual review (chain budget reached)',
            description:
              'The global daily budget for moderation-chain runs is exhausted, so the ' +
              'listing gate cannot run today. Approve or deny from the admin console, ' +
              'or wait for the counter to roll at 00:00 UTC.',
            color: COLOR_AMBER,
            footer: 'The work stays readable by link; it is NOT listed until you decide.',
          });
        }
        return;
      }
      verdict = await runChainVerdict(apiKey, bundle, workId);
      // The chain ran — record the observation, fingerprinted and guarded on
      // the reviewed content hash (a concurrent update would make the guarded
      // write no-op, never stamping a verdict onto superseded content).
      await setModerationVerdict(
        env.SHELF_DB,
        workId,
        JSON.stringify(verdict),
        new Date().toISOString(),
        currentHash,
        currentFingerprint,
      );
    }

    // A truncated review only sampled a long work — it must never AUTO-list
    // (or auto-refuse); the omitted spans are exactly where hidden content
    // would sit. Route pass/tag-fix on a truncated verdict to a human. (hold
    // already goes to a human below; error/skipped fail safe below.)
    if (verdict.truncated && (verdict.outcome === 'pass' || verdict.outcome === 'tag-fix')) {
      if (await resolveAndConfirm(env, workId, 'held', null, { reason: 'truncated' })) {
        await notifyListingDiscord(env, workId, row.title, {
          title: 'LISTING HELD — work too long for full automated review',
          description:
            'The moderation chain could only sample this work, so it was not ' +
            'auto-listed. Review the full text and approve or deny from the admin console.',
          color: COLOR_EMBER,
          footer: 'The work stays readable by link; it is NOT listed until you decide.',
        });
      }
      return;
    }

    switch (verdict.outcome) {
      case 'pass': {
        const listedAt = new Date().toISOString();
        const v: ListingVerdict | null = reused ? { reused: true } : null;
        if (await resolveAndConfirm(env, workId, 'listed', listedAt, v)) {
          // Informational, early-days visibility — the shelf is small enough
          // that the operator wants to see every arrival.
          await notifyListingDiscord(env, workId, row.title, {
            title: 'Listed on the Shelf',
            description: `by ${row.pen_name} — rated ${row.rating}`,
            color: COLOR_VIOLET,
            footer: 'Informational — the gate passed this work.',
          });
        }
        return;
      }
      case 'tag-fix': {
        // Author-facing, no Discord: the fix is theirs to make, no human needed.
        const v: ListingVerdict = {
          reason: 'labels',
          ...(verdict.suggested !== undefined ? { suggested: verdict.suggested } : {}),
          ...(reused ? { reused: true as const } : {}),
        };
        await resolveAndConfirm(env, workId, 'refused', null, v);
        return;
      }
      case 'hold': {
        const v: ListingVerdict = { reason: 'review', ...(reused ? { reused: true as const } : {}) };
        if (await resolveAndConfirm(env, workId, 'held', null, v)) {
          await notifyListingDiscord(env, workId, row.title, {
            title: 'LISTING HELD — needs your decision',
            description: verdict.reason ?? 'hard-line suspicion, no detail recorded',
            color: COLOR_EMBER,
            footer: 'The work stays readable by link; it is NOT listed until you decide.',
          });
        }
        return;
      }
      // 'skipped' can't actually reach here (the reuse filter excludes it and
      // runChainVerdict never returns it) — but if it somehow did, the fail-
      // safe direction is the same as a broken chain: held, a human decides.
      case 'skipped':
      case 'error': {
        if (await resolveAndConfirm(env, workId, 'held', null, { reason: 'error' })) {
          await notifyListingDiscord(env, workId, row.title, {
            title: 'LISTING HELD — chain error',
            description: verdict.reason ?? 'moderation chain failed',
            color: COLOR_AMBER,
            footer: 'Fail safe: a human decides — a broken chain never lists.',
          });
        }
        return;
      }
    }
  } catch (e) {
    // Belt to the suspenders above: even an unexpected throw must resolve the
    // pending state (fail safe: held), and waitUntil must never see a rejection.
    console.error(`[listing] unexpected: ${e instanceof Error ? e.message : String(e)}`);
    try {
      await resolveListingPending(env.SHELF_DB, workId, 'held', null, JSON.stringify({ reason: 'error' }));
    } catch {
      /* the pending row will surface on the admin console either way */
    }
  }
}
