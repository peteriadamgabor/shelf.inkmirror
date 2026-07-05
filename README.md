# The Shelf — shelf.inkmirror.cc

The reading room next door to [InkMirror](https://inkmirror.cc). Writers
publish drafts or finished works from the editor and share them by link;
later, an open browsable shelf. No accounts — capability URLs and
manage-secrets. Legal 18+ content allowed, honestly labeled (AO3 model:
police labels and legality, never themes).

**Status:** Phase 0 scaffold. Routes are stubs; the wire contract
(`src/format.ts`) and its validator are real.

## Architecture

- **Cloudflare Worker + R2 + D1.** No VPS, no framework — reading pages are
  baked to static HTML at publish time and served straight from R2.
- **`PublishBundleV1`** (`src/format.ts`) is the canonical wire contract with
  the InkMirror editor, which vendors the types in its `src/publish/format.ts`.
  Breaking changes bump `version`.
- **Privacy by contract:** the bundle never carries graveyard blocks, note
  blocks, sentiments, revisions, per-block timestamps, or character notes.
  The client strips; the server re-validates and rejects unstripped bundles.
- Client JS is a few vanilla-TS islands (age gate, report form, manage page).
  No React/Vue/etc. — there is no app to hydrate.

Full design: `docs/specs/2026-07-05-shelf-publish-design.md`.

## Phases

1. **Phase 1** — publish → unlisted link: publish/manage/report/read routes,
   baked renderer, 30-day renewable expiry, report → Discord, daily purge cron.
2. **Phase 2** — LLM moderation chain (router pass + verifier), shadow mode.
3. **Phase 3** — the public shelf (browse page); moderation becomes the gate.

## Setup

```sh
npm install
npx wrangler r2 bucket create inkmirror-shelf
npx wrangler d1 create inkmirror-shelf     # paste database_id into wrangler.jsonc
npx wrangler secret put DISCORD_WEBHOOK
npx wrangler secret put ANTHROPIC_API_KEY  # Phase 2
npm run dev
```

DNS: add `shelf.inkmirror.cc` as a custom domain (already declared in
`wrangler.jsonc` routes).

## Scripts

- `npm run dev` — local Worker via wrangler
- `npm run deploy` — deploy to production
- `npm run typecheck` / `npm test`
