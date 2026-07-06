# The Shelf — publish & share design

**Date:** 2026-07-05
**Status:** Draft for review
**Domain:** `shelf.inkmirror.cc`

InkMirror gains a sibling: a place where writers can publish drafts or finished
works and share them by link, and — later — list them in an open, browsable
showcase. InkMirror stays the quiet mirror; the Shelf is the reading room next
door.

## Goals

- One-click publish of a book (or selected chapters) to a shareable read-only URL.
- No accounts, ever. Capability URLs + manage-secrets, same philosophy as sync.
- Open community: legal 18+ content allowed, labeled honestly (AO3 model —
  police labels and legality, not themes).
- Moderation that scales to one operator: static routing + LLM verification +
  human-in-the-loop only for hard-line holds.
- Nearly everything built for link-share (Phase 1) is reused by the public
  shelf (Phase 3).

## Non-goals

- Comments, likes, follows, feeds. The shelf is a library table, not a social
  network. Revisit only on demonstrated demand, consciously.
- Accounts, server-readable analytics, subscriptions (per project constitution).
- Image uploads (covers are generated typography). Text-only keeps moderation
  and legal posture manageable.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Host on Cloudflare (Worker + R2 + D1), no VPS | Zero ops, zero egress, DDoS/TLS free. CF's Acceptable Hosting Policy targets illegal content, not legal adult fiction. R2 is S3-compatible → migration later is a weekend, not a rewrite. |
| D2 | **Separate repo & project** (working name `inkmirror-shelf`), own Worker bound to `shelf.inkmirror.cc` | Separate product, separate blast radius, keeps InkMirror small. The only true coupling is the `PublishBundleV1` wire format — treated as a versioned protocol (shelf repo owns the canonical definition + server validator; InkMirror vendors the type and implements the client side). Worker patterns (rate-limit bindings, constant-time secret compare, Discord report handler) are copied once from InkMirror, then evolve independently. No shared npm package / submodule — machinery not warranted for one interface. |
| D3 | Published works stored **plaintext**, not E2E | Publishing is the writer saying "I want this readable." Plaintext keeps takedown/moderation real. E2E stays where privacy is the intent: sync. |
| D4 | Reading pages are **baked at publish time** — Worker renders static HTML into R2 | Serving = R2 fetch + header wrap. No client framework needed to read a book. Update = re-bake. Cheap, fast, cacheable. |
| D5 | Ratings + warning tags are author-declared and mandatory; enforcement targets **mislabeling and hard lines**, never themes | Theme bans are unjudgeable for fiction (would ban half of literature). Label verification is a cheap yes/no. |
| D6 | Link-shares are unlisted and skip moderation (reactive posture: report → takedown). The shelf listing (Phase 3) is the moderation gate | Unlisted links = plumbing, like a Docs link. Public listing = distribution, needs the gate. |
| D7 | Auto-expiry 30 days, renewable via manage link | Abandoned/abusive content evaporates by default. Shelf-listed works exempt while listed. |

## Published bundle format

The wire contract between the two repos. Canonical definition + server
validator live in the **shelf repo**; InkMirror vendors the type
(`src/publish/format.ts`) and implements the client side. Shaped as a sibling
to `DocumentBundleV1`:

```ts
export const PUBLISH_BUNDLE_KIND = 'inkmirror.published';

export interface PublishBundleV1 {
  kind: typeof PUBLISH_BUNDLE_KIND;
  version: 1;
  app_version: string;
  title: string;
  pen_name: string;              // free text, no uniqueness (no accounts)
  language: 'en' | 'hu' | string;
  rating: 'general' | 'mature' | 'explicit';
  warnings: string[];            // from a fixed vocabulary (see Policy)
  document: Document;            // pov + typeface prefs travel for rendering
  chapters: Chapter[];           // selected chapters only, all kinds allowed
  blocks: Block[];               // FILTERED — see below
  characters: PublishedCharacter[]; // slim: { id, name, color } only
}
```

**Block filtering is a privacy requirement, not an optimization.**
`DocumentBundleV1` deliberately carries the graveyard (soft-deleted blocks)
and `note` blocks. The publish exporter MUST strip:

- every block with `deleted_at != null` (the graveyard is private),
- every `note` block (already excluded from all exporters),
- `sentiments` and `block_revisions` entirely (writer's private telemetry).

Character records are slimmed to display needs (`name`, `color` for dialogue
pills) — descriptions/arc notes stay home.

Server-side, the shelf Worker re-runs deep validation (its own validator,
written in the style of `validateDocumentBundle` in InkMirror's
`src/backup/format.ts`) and **independently re-applies the strip rules** —
never trust the client to have filtered.

## Shelf Worker — API

Lives in the shelf repo (`src/worker.ts` there). Patterns to copy once from
InkMirror: rate-limit bindings (`RL_SYNC_*` style), `constantTimeEqualBytes`
from `src/sync/crypto.ts`, the feedback handler's honeypot/caps shape for
reports, and the security-headers wrapper.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/publish` | POST | Validate + bake + store. Returns `{ id, url, manageSecret }`. CORS-allowed origin: `https://inkmirror.cc` only. |
| `/api/works/:id` | PUT | Replace content (re-bake). Requires `X-Manage-Secret`. |
| `/api/works/:id` | DELETE | Unpublish. Requires secret. |
| `/api/works/:id/renew` | POST | Push `expires_at` +30d. Requires secret. |
| `/api/works/:id/report` | POST | Reporter picks the rule violated + optional note → Discord webhook (reuses feedback handler pattern: honeypot, length caps). |
| `/api/works/:id/letters` | POST | Reader → author letter (see Letters). Honeypot + caps + `RL_SHELF_LETTER`; 404s when the author disabled letters. |
| `/api/works/:id/letters` | GET | Author reads letters. Requires `X-Manage-Secret`. |
| `/w/:id` | GET | Reading page (baked HTML from R2, wrapped with headers + age gate). Increments `views` via `ctx.waitUntil` with a short per-IP cooldown. |
| `/w/:id/manage` | GET | Manage page (views count, letters, renew/unpublish). Secret arrives in URL fragment, JS calls the API — the secret never hits server logs. |
| `/` , `/rules` | GET | Landing + rules page (static). |
| Cron trigger | daily | Purge works past `expires_at` (D1 row + R2 objects). |

**Limits (Phase 1, all enforced server-side):**

- Body cap: 10 MB JSON (a 200k-word novel is ~2 MB; generous headroom).
- Row caps: reuse `MAX_CHAPTERS` / `MAX_BLOCKS` bounds from `format.ts`.
- Rate limits (CF rate-limit bindings, same pattern as `RL_SYNC_*`):
  `RL_SHELF_PUBLISH` (e.g. 5/h/IP), `RL_SHELF_MANAGE`, `RL_SHELF_REPORT`,
  `RL_SHELF_LETTER` (e.g. 5/h/IP).
- Publishes per manage-secret update: unlimited (author's own work).

**Secrets:** `id` = 16 random bytes base64url (22 chars, 128 bits — the id
IS the capability for unlisted works, so it matches the sync layer's syncId
entropy; stronger than a UUIDv4 and shorter in the URL). `manageSecret` =
32 bytes base64url. D1 stores only `sha256(secret)`; comparison is
constant-time (reuse `constantTimeEqualBytes` from sync). Both come from
`crypto.getRandomValues` — never `Math.random`, never sequential.

## Storage

**R2** (`INKMIRROR_SHELF_R2`):

```
works/{id}/bundle.json   # canonical PublishBundleV1 (source for re-bake/export)
works/{id}/index.html    # baked reading page
```

**D1** (`inkmirror_shelf`), table `works`:

```sql
CREATE TABLE works (
  id            TEXT PRIMARY KEY,
  secret_hash   TEXT NOT NULL,
  title         TEXT NOT NULL,
  pen_name      TEXT NOT NULL,
  language      TEXT NOT NULL,
  rating        TEXT NOT NULL CHECK (rating IN ('general','mature','explicit')),
  warnings      TEXT NOT NULL DEFAULT '[]',   -- JSON array
  word_count    INTEGER NOT NULL,
  first_line    TEXT NOT NULL DEFAULT '',     -- shelf card teaser (Phase 3)
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','held','removed')),
  listed        INTEGER NOT NULL DEFAULT 0,   -- Phase 3
  password_hash TEXT,                         -- NULL = no password gate
  views         INTEGER NOT NULL DEFAULT 0,   -- opens, author-only (see below)
  letters_open  INTEGER NOT NULL DEFAULT 1,   -- author's "accept letters" toggle
  report_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
```

Phase 2 adds `moderation_verdict` / `moderation_at` columns.

### Visibility tiers (per-work, chosen in the publish modal)

1. **Unlisted link** (default) — anyone with the link reads; listed nowhere,
   `noindex`. Reactive moderation (report → takedown).
2. **Password-locked** — link + password the author shares personally (beta
   readers, writing circles). Optional `password_hash` (argon2id or
   scrypt via WebCrypto-available KDF; decide at implementation) gates the
   page: POST password → HttpOnly cookie scoped to `/w/:id` → baked HTML
   served. Attempts rate-limited per IP. Effectively private, so no
   moderation gate. Content remains plaintext server-side so takedown and
   re-bake keep working; a future client-side-encrypted tier could serve
   true zero-knowledge drafts but is out of scope (breaks server
   re-validation and report review).
3. **On the shelf** (Phase 3) — publicly listed; the only tier that pays the
   moderation toll. `listed = 1`, exempt from auto-expiry while listed.

A password cannot be combined with `listed = 1` — a public listing that
nobody can open is a support burden, not a feature.

### Views (author-only)

`views` counts *opens* of `/w/:id` — incremented in the Worker via
`ctx.waitUntil` after serving, with a short per-IP cooldown (KV key with
~10-min TTL) so refresh spam and bots don't inflate it grossly. Shown ONLY on
the manage page, labeled "opens" (honest: not unique readers). **Never shown
on the public shelf and never used for ranking** — public counts turn the
shelf into a leaderboard, which is exactly the social physics this product
refuses. The shelf sorts by recency and filters, not popularity.

### Letters (reader → author feedback)

Not comments. A quiet "Write to the author" form at the end of a work: the
letter goes privately to the writer, one-way, no threads, no public trace.
Reader may optionally leave a contact line if they want an answer.

```sql
CREATE TABLE letters (
  id         TEXT PRIMARY KEY,
  work_id    TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,              -- cap 4000 chars
  contact    TEXT NOT NULL DEFAULT '',   -- cap 200 chars, optional
  created_at TEXT NOT NULL
);
```

Abuse posture = the feedback form's: honeypot field, min-render-to-submit
gate, length caps, `RL_SHELF_LETTER` per IP, per-work cap (e.g. 500 stored;
oldest evicted). `letters_open = 0` hides the form and 404s the endpoint.
Letters are readable/deletable from the manage page only. The author is a
private recipient, not a moderator — but the letter form still notes that
hard-line content in letters can be reported.

## Reading page

Baked at publish time from the bundle. Design language: the editor's reading
surface — serif body, light-cream, chapter-kind layouts (cover/dedication/
epigraph centered, front/back-matter ordering from the exporters), dialogue
speaker pills, `.inkmirror-paper` grain. CSS is a one-time snapshot of the
relevant `src/index.css` tokens into the shelf repo's `shelf-theme.css`
(copied, not live-shared — the reading page's look may diverge on purpose).
Dark mode via `prefers-color-scheme`. Reduced-motion respected (trivially —
the page is nearly static).

Chrome on every page:

- Rating badge + warning tags at the top (before any prose).
- **Age gate** on `mature`/`explicit`: full-page interstitial ("Rated
  Explicit — 18+ only"), click-through persisted in `localStorage`. Content
  is not in the initial paint until confirmed (gate wraps the body, JS
  reveals). `noindex,nofollow` on ALL `/w/*` pages regardless of rating.
- Footer: pen-name · published date · word count · "Report this work" link
  (→ `/api/works/:id/report` mini-form) · "Written with InkMirror" mark.

### Chaptered reading

- **Single-chapter works** (exactly one chapter after ordering, regardless
  of kind) bake to one page at `works/{id}/index.html` — unchanged. A short
  story never gains a TOC click.
- **Multi-chapter works bake N+1 pages.** The cover at
  `works/{id}/index.html` (`/w/:id`): title, pen name, rating badge +
  warning chips, synopsis, front-matter prose (cover/dedication/epigraph
  render right there, centered, per kind rules), a "Continue reading" slot,
  and the TOC — an ordered list of the N body chapters (standard + back
  matter, reading order) with per-chapter word counts (tabular-nums). Labels
  fall back to "Chapter N" when the kind hides titles (`showsTitle`) or the
  title is empty. The continue slot is `hidden` until inline JS finds
  `localStorage['shelf.pos.{workId}']` (so it's also hidden under noscript)
  and then links "Continue — {chapter title}" to `/w/:id/{n}`.
- **Chapter pages** at `works/{id}/ch/{n}.html`, served at `/w/:id/{n}`
  (n = 1–999; the route regex rejects `0`, leading zeros, and non-numeric —
  styled 404). Slim header (work title → cover, "n / total"), compact
  prev/next on top, the chapter's blocks exactly as the single page renders
  them, prev/next at the bottom (prev of page 1 = the cover; the last page
  shows a Contents link instead of next), the standard whole-work footer.
  Inline JS stamps `localStorage['shelf.pos.{workId}'] = n` on load.
- **Age gate on EVERY page** of a mature/explicit work — deep links must
  gate. The localStorage ack keeps it one-time across pages.
- **Views count only on the cover route.** Chapter fetches never increment
  `views` — paging through a book is one open, not twelve. The `RL_VIEWS`
  cooldown is unchanged.
- **One bake pipeline:** `bakeWork()` (POST publish, PUT update, admin
  relabel) renders all pages, writes them to R2, and deletes stale
  `works/{id}/ch/*` beyond the new count — a re-push shrinking 12 → 9
  chapters must not leave `/w/:id/10` serving. Unpublish and the purge cron
  delete the whole `works/{id}/` prefix via R2 list, not fixed keys.

## InkMirror-side publish flow

This part stays in the InkMirror repo regardless of the split — it is client
code. New feature module `src/ui/features/PublishModal.tsx` +
`src/store/publish.ts` + vendored `src/publish/format.ts`:

1. Writer opens Publish from the document menu / command palette.
2. Picks scope (whole book / chapters), **rating (mandatory)**, warning tags,
   pen-name, language. Modal shows what will be stripped (notes, graveyard,
   history) — the mirror is honest about what leaves.
3. First publish must acknowledge the rules (link to `/rules`), stored per
   browser.
4. POST to `shelf.inkmirror.cc/api/publish`; on success store
   `{ workId, documentId, scope, url, manageSecret, publishedAt, rating }`
   in a new IDB store `publications` — keyed by `workId`, indexed by
   `documentId`, because one document may yield several published works
   (chapters 1–3 as a teaser, the full book as another) — schema v6
   migration. The document's own UUID never travels in the bundle; this
   store is the only place the local↔published link exists.
5. Published documents show a "published" chip with Update / Unpublish /
   Copy-link actions (call the manage API directly with the stored secret).
   Updates are explicit snapshot pushes (PUT → server re-validates,
   re-strips, re-bakes) — never automatic on save. The chip may hint
   "published version behind local" by comparing timestamps, but the
   writer decides when a new version faces readers.

All strings through `t()`, en + hu from day one.

## Policy (ratings · warnings · hard lines)

Lives at `shelf.inkmirror.cc/rules`, exists before the first explicit work.

- **Ratings:** General (all ages) · Mature (16+, non-explicit adult themes) ·
  Explicit (18+, explicit sex/violence).
- **Warning vocabulary (fixed list, author-checked):** graphic violence ·
  sexual content · sexual violence · self-harm/suicide · child abuse
  (non-sexual depiction) · substance abuse · other (free text).
- **Hard lines (removal + no appeal):** sexual content involving minors ·
  doxxing/harassment of real persons · plagiarism (on credible claim) ·
  content illegal under Cloudflare's Acceptable Hosting Policy.
- **The bannable offense for everything else is mislabeling**, judged as a
  yes/no ("does the work contain what the tags say?"), not literary merit.

## Moderation chain (Phase 2)

Runs **in the shelf Worker** (client-side previews are courtesy only — the
Worker's verdict is the real one).

1. **Router pass** — blocks chunked (~2k tokens), Claude Haiku with a tight
   rubric flags chunks per category, plus a random sample of unflagged chunks
   (plain-language evasion catch).
2. **Verifier pass** — model reads flagged chunks in context and answers only:
   (a) hard line crossed? (b) declared rating/warnings honest?
3. **Outcomes:**
   - `pass` — publish proceeds.
   - `tag-fix` — author gets a block-anchored report (heatmap-style, the
     scan-visual language of the editor) with suggested rating/tags;
     one-click accept & republish.
   - `hold` — hard-line suspicion → Discord ping with excerpt + work id;
     human decides. Never auto-reject, never auto-publish.
4. **Rollout:** built in Phase 2 but wired as shadow-mode on link publishes
   (verdict logged to Discord, never blocks) → real false-positive rate on
   real fiction before the shelf makes it a gate.

Cost: Haiku-class routing + verification ≈ low single-digit cents per novel.
The publish rate limit is also the API-budget guard.

## Phase 1.5 — operator toolkit (shipped)

Phase 1 shipped with reactive moderation (report → Discord → human) but no
tooling for the human. Phase 1.5 is that tooling: one page, one secret, and
the enforcement primitives the rules page promises.

### Admin surface

- **`GET /admin`** — operator console, same trust model as the manage page:
  the admin secret rides in the URL *fragment*, lives in JS memory, and
  travels only as the `X-Admin-Secret` header. The page is static and
  identical for every visitor. Sections: stats row (works by status, total
  opens, paused indicator) · panic switch · recent works as mobile-friendly
  cards (Remove/Restore, inline Re-label, Expiry set, link to `/w/:id`) ·
  recent reports · tombstone list with delete.
- **`/api/admin/*`** — all JSON, all authenticated by comparing
  `sha256(X-Admin-Secret)` against `sha256(env.ADMIN_SECRET)` constant-time,
  rate-limited via `RL_MANAGE`. When `ADMIN_SECRET` is unset **or** the
  header is wrong, every admin route answers the exact 404 an unknown route
  produces — the surface is not discoverable by probing.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/admin/overview` | GET | counts by status, total opens, last 20 works, last 20 reports (joined with work title), pause state, tombstones |
| `/api/admin/works/:id` | GET | full row (minus secret hashes) + its reports |
| `/api/admin/works/:id/remove` | POST | `status='removed'`, `removed_at=now`; body `{ tombstone?, note? }` optionally tombstones the content |
| `/api/admin/works/:id/restore` | POST | back to `active` (only from `removed`) |
| `/api/admin/works/:id/relabel` | POST | `{ rating, warnings }` from the fixed vocabularies → D1 update + R2 bundle mutate + re-bake; the author's next manage GET shows the corrected labels |
| `/api/admin/works/:id/expiry` | POST | `{ days: 1..365 }` → `expires_at = now + days` |
| `/api/admin/pause` | POST | `{ paused }` → `settings.publishing_paused` |
| `/api/admin/tombstones/:hash` | DELETE | forgive a tombstone |

### Removal lifecycle (grace window)

Operator removal flips `status='removed'` and stamps `removed_at`; readers
get the same 404 as a nonexistent work, but the D1 row and both R2 objects
survive so **restore is one click for 30 days**. The daily purge evaporates
removed works once `removed_at` is older than 30 days (and, conversely,
removed works are exempt from the ordinary `expires_at` purge while in the
grace window — removal must not shorten the operator's undo period).

### Tombstones (content bans)

`tombstones(content_hash PRIMARY KEY, work_title, created_at, note)`.
The hash is `sha256Hex(blocks.map(content).join(' '))` with blocks ordered by
**(chapter order, block order)** — deliberately blind to title, pen name,
rating, warnings, marks, and ids, so a removed work re-uploaded under a new
identity still matches. Any single character of prose changed produces a new
hash: a tombstone is a takedown record, not a similarity net (that would be
Phase 2's LLM job).

Both `POST /api/publish` and `PUT /api/works/:id` check, after validation
and before any write:

1. **Panic switch** — `settings.publishing_paused = '1'` → `503
   { error: 'publishing_paused', message: 'The Shelf is temporarily closed
   for new works.' }` (the message is human because InkMirror surfaces it
   as-is).
2. **Tombstone match** → flat `403 { error: 'not_acceptable' }` with no
   detail — no oracle telling an abuser what exactly got them removed or
   how far a mutation must go.

### Reports in D1

Every **accepted** report (past honeypot, render-time gate, and optional
Turnstile) is inserted into `reports(id, work_id, reason, message,
created_at)` and bumps `works.report_count` **before** the Discord forward —
Discord failing (or being unconfigured) no longer loses reports; it is the
doorbell, D1 is the record. Reports for a purged/unpublished work are
deleted with it.

**Nothing about the reporter is stored** — no IP, no hash, no cookie — by
decision. Consequently there are no per-source bans; that was considered and
consciously skipped (IP bans are trivially evaded and the privacy cost is
permanent). The same privacy stance applies to publishers: no publisher
IPs/fingerprints are recorded, so enforcement is content-shaped (tombstones)
rather than person-shaped.

### Live report page

Baked reading pages no longer embed the report form; their footer links to
**`GET /w/:id/report`**, a Worker-rendered (live) page with the same fields,
honeypot, and render-time gate. This decouples the evolving form from baked
HTML — old baked pages with the inline form keep working against the same
POST endpoint.

**Turnstile (optional):** when `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY` are both set, the report page embeds the widget and
the POST handler verifies `cf-turnstile-response` against `siteverify`
(403 on failure). Unset = current honeypot-only behavior. The CSP relaxation
(`script-src`/`frame-src https://challenges.cloudflare.com`) applies to this
one page only; every other page keeps the strict inline-only policy.

### Config

New optional secrets: `ADMIN_SECRET`, `TURNSTILE_SITE_KEY`,
`TURNSTILE_SECRET_KEY`. Migration `0002_admin.sql` adds `works.removed_at`,
`reports`, `tombstones`, `settings`.

## Phase 3 — the shelf (sketch, own spec later)

- `GET /shelf` — browse page: generated-typography covers, title, pen-name,
  first line, rating badge, tags; filter by rating/tag/language. Cards link
  to the same `/w/:id` pages.
- "List on the shelf" = separate checkbox in the publish modal → moderation
  chain becomes a hard gate → `listed = 1`.
- Listed works exempt from auto-expiry while listed; delisting is one click
  on the manage page.
- `/shelf` is indexable; `/w/*` stays `noindex`.

## Reuse map

| Built in Phase 1 | Phase 3 reuse |
|---|---|
| Worker skeleton, limits, secrets | unchanged |
| R2 layout + D1 schema | + `listed` flag + one query |
| Baked reading pages | linked as-is from shelf cards |
| Manage lifecycle, expiry, report, kill switch | unchanged |
| Publish modal + rating/tags metadata | + one checkbox |
| Moderation chain (shadow) | flipped to gate |

## Phasing

1. **Phase 0 (evening):** create `inkmirror-shelf` repo · rules page copy
   (en+hu) · DNS `shelf.inkmirror.cc` · freeze `PublishBundleV1`.
2. **Phase 1 (~2–3 days):** shelf repo: Worker (publish/manage/report/read/
   cron) + baked renderer + server re-validation · InkMirror repo: publish
   exporter with strip rules + PublishModal + IDB `publications` (schema v6)
   + i18n.
2.5. **Phase 1.5 (1 day):** operator toolkit — /admin console, admin API,
   removal grace window, tombstones, panic switch, reports in D1, live
   report page with optional Turnstile. See the Phase 1.5 section above.
3. **Phase 2 (~1–2 days):** moderation chain in shadow mode.
4. **Phase 3 (~1–2 days):** browse page + gate flip.

## Open questions

1. Does the baked page need an "export as EPUB" button for readers, or is
   that scope creep? (Lean: creep — later.)
2. Pen-name collisions are possible by design (no accounts). Acceptable?
   (Lean: yes — like book covers in the real world.)
3. Should `hu` works get a `lang="hu"` + Hungarian chrome automatically from
   `language`? (Lean: yes, trivial via existing i18n dictionaries.)
4. ~~Worker code layout~~ — resolved: separate repo (`inkmirror-shelf`),
   see D2. Remaining sub-question: final repo/product name.
