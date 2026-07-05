# CLAUDE.md — The Shelf

Publish & share side app for InkMirror (the AI-assisted novel editor at
https://inkmirror.cc, repo at `/mnt/Development/StoryForge`). Writers publish
works by explicit choice and share them by unlisted link; Phase 3 adds an open
browsable shelf. This repo is the **server + reading surface**; the publish UI
lives in the InkMirror repo.

Production (when live): https://shelf.inkmirror.cc
Design spec: `docs/specs/2026-07-05-shelf-publish-design.md` — read it before
touching anything nontrivial.

## Stack (required)

- **Cloudflare Worker + R2 + D1** — TypeScript strict, `wrangler`, vitest.
- **No client framework.** Reading pages are baked to static HTML at publish
  time (stored in R2 next to the bundle) and served as-is. Interactivity is
  small vanilla-TS islands: age gate, report form, manage page. If a page ever
  genuinely needs a framework, it's Solid (same brain as InkMirror) — never
  React/Vue/Angular/Next.
- **`any` is forbidden.** Discriminated unions, same discipline as InkMirror.
- Package manager: **npm**.

## Non-negotiable rules

1. **`src/format.ts` is the canonical wire contract** (`PublishBundleV1`).
   InkMirror vendors a copy of the types. Any breaking change bumps `version`
   and keeps the old version readable. Never import from the InkMirror repo —
   the contract is the only coupling, by decision (spec D2).
2. **Never trust the client.** Every publish/update re-runs
   `validatePublishBundle` server-side. The validator REJECTS unstripped
   backup bundles (graveyard fields, note blocks, character notes/aliases,
   per-block timestamps). Weakening these checks is a privacy incident, not a
   refactor.
3. **No accounts, ever.** Capability URLs + manage-secrets. D1 stores only
   `sha256(secret)`; comparisons are constant-time. Secrets travel in the
   `X-Manage-Secret` header or URL *fragment* — never in a path or query
   string (they end up in logs).
4. **Policy enforces labels and legality, never themes.** Ratings
   (general/mature/explicit) + fixed warning vocabulary are author-declared;
   the bannable offense is mislabeling or a hard line (minors, doxxing,
   plagiarism). Don't add theme-based filters.
5. **Moderation holds are human-decided.** The LLM chain (Phase 2) may pass,
   suggest tags, or hold → Discord. It must never auto-reject or auto-publish
   a hard-line suspicion.
6. **All `/w/*` pages ship `noindex, nofollow`** regardless of rating, and
   mature/explicit pages render behind the age-gate interstitial. The Phase 3
   `/shelf` browse page is the only indexable content surface.
7. **Rate limits and size caps on every write route.** The publish endpoint
   becomes an API-spending endpoint in Phase 2 — the limits are the budget
   guard, not just abuse control.
8. **Reading pages must work with JS disabled** except the age gate and
   forms. They're static HTML; keep them that way. Mobile-first, dark mode
   via `prefers-color-scheme`, `prefers-reduced-motion` respected.

## Design language

The editor's reading vocabulary, snapshotted (not live-shared) from InkMirror:
serif prose on light cream (`stone-100`-ish warm), dark mode with the faint
violet undertone, dialogue speaker pills in character colors, POV dialogue
right-aligned. Chapter kinds (cover/dedication/epigraph/acknowledgments/
afterword) follow InkMirror's exporter layout rules. Quiet by default —
this is a reading room, not a feed.

## Git / commit

Same format as InkMirror: `<type>(<scope>): <description>`.
Scopes here: `worker` · `format` · `render` · `pages` · `moderation` · `dev`.

## If you get stuck

Ask, don't guess — especially on anything touching rule 2 (privacy) or
rule 4 (policy).
