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
| `/api/works/:id/password` | PUT | **(shipped)** Set/clear the reading password. Body `{ password: string \| null }` (4–128 chars). Requires `X-Manage-Secret`, rides `RL_MANAGE`. |
| `/api/works/:id/listing` | PUT | **(shipped, Phase 3)** Body `{ list: boolean }` — request (→ the gate) or withdraw a shelf listing. Requires `X-Manage-Secret`. See "Phase 3". |
| `/api/works/:id/labels` | PUT | **(shipped, Phase 3)** Body `{ rating, warnings }` — author-authorized relabel + re-bake (accept-suggested-labels flow). Requires `X-Manage-Secret`. |
| `/api/works/:id/letters` | POST | **(shipped)** Reader → author letter (see Letters). Honeypot + caps + `RL_LETTER`; 404s when the author disabled letters. |
| `/api/works/:id/letters` | GET | **(shipped)** Author reads letters: `{ lettersOpen, letters[] }` newest first. Requires `X-Manage-Secret`. |
| `/api/works/:id/letters/:letterId` | DELETE | **(shipped)** Author deletes one letter. Requires `X-Manage-Secret`. |
| `/api/works/:id/letters-open` | PUT | **(shipped)** Body `{ open: boolean }` — toggle the mailbox. Requires `X-Manage-Secret`. |
| `/w/:id` | GET | Reading page (baked HTML from R2, wrapped with headers + age gate + password gate). Increments `views` via `ctx.waitUntil` with a short per-IP cooldown — only on a successful content serve, never on the gate. |
| `/w/:id/unlock` | POST | **(shipped)** Password-gate unlock: verify → per-work cookie → 303 back to the page (`next`, same-work paths only). `RL_UNLOCK` per (ip, work). |
| `/w/:id/letter` | GET | **(shipped)** Live letter form (same pattern as `/w/:id/report`); 404 while `letters_open = 0`. |
| `/w/:id/manage` | GET | Manage page (views count, password, letters, renew/unpublish). Secret arrives in URL fragment, JS calls the API — the secret never hits server logs. |
| `/` , `/rules` | GET | Landing + rules page (static). |
| `/shelf` | GET | **(shipped, Phase 3)** Public browse page — live-rendered, filterable, paginated, the ONE indexable route. |
| Cron trigger | daily | Purge works past `expires_at` (D1 row + R2 objects). |

**Limits (Phase 1, all enforced server-side):**

- Body cap: 10 MB JSON (a 200k-word novel is ~2 MB; generous headroom).
- Row caps: reuse `MAX_CHAPTERS` / `MAX_BLOCKS` bounds from `format.ts`.
- Rate limits (CF rate-limit bindings, same pattern as `RL_SYNC_*`; CF only
  accepts periods of 10/60 s, so hourly budgets are approximated per-minute):
  `RL_PUBLISH` (2/min/IP), `RL_MANAGE` (30/min/IP), `RL_REPORT` (2/min/IP),
  `RL_VIEWS` (view-count cooldown, 1/min per ip+work), `RL_UNLOCK`
  (password-gate attempts, 5/min per ip+work), `RL_LETTER` (2/min/IP).
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

Phase 2 added `moderation_verdict` / `moderation_at` columns
(`migrations/0004_moderation.sql`) — see "Moderation chain" below.

### Visibility tiers (per-work, chosen in the publish modal)

1. **Unlisted link** (default) — anyone with the link reads; listed nowhere,
   `noindex`. Reactive moderation (report → takedown).
2. **Password-locked** — **(shipped)** link + password the author shares
   personally (beta readers, writing circles). The author sets it from the
   manage page (`PUT /api/works/:id/password`, `X-Manage-Secret`, body
   `{ password: string | null }`, 4–128 chars); no InkMirror-side change.
   Implementation decisions:
   - **KDF: PBKDF2-SHA256 via WebCrypto** (100 000 iterations, 16-byte
     random salt) — argon2id/scrypt are not WebCrypto-available in Workers.
     Stored as `pbkdf2$100000$<salt-b64url>$<hash-b64url>` in
     `works.password_hash`; NULL = no gate.
   - **Gate:** while `password_hash` is set, `/w/:id`, `/w/:id/{n}`,
     `/w/:id/report` and `/w/:id/letter` serve a gate page (title, pen name,
     lock, password form) instead of content unless the request carries a
     valid unlock cookie. Gate serves never count views; locked content is
     served `cache-control: no-store` so it can't sit in a shared cache.
     The manage page stays reachable — the manage secret is stronger
     authority than the reading password.
   - **Unlock cookie:** `POST /w/:id/unlock` verifies the password
     (constant-time compare of the derived bytes; attempts rate-limited by
     `RL_UNLOCK`, 5/min per (ip, work)), then sets
     `shelf_u_{id} = base64url(HMAC-SHA256(key: the stored password_hash
     string, message: id))` — HttpOnly, Secure, SameSite=Lax,
     `Path=/w/{id}`, Max-Age 30 days — and 303s back to the page (`next`
     form field, restricted to same-work `/w/:id...` paths). Verification
     recomputes the HMAC and compares constant-time. Because the HMAC key IS
     the stored hash, changing or clearing the password rotates the key and
     invalidates every outstanding cookie automatically — no session state,
     no extra secret.
   Effectively private, so no moderation gate. Content remains plaintext
   server-side so takedown and re-bake keep working; a future
   client-side-encrypted tier could serve true zero-knowledge drafts but is
   out of scope (breaks server re-validation and report review).
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

### Letters (reader → author feedback) — shipped

Not comments. A quiet "Write to the author" link in every baked footer leads
to the live page `GET /w/:id/letter` (same pattern as the live report page —
the form evolves without re-baking): the letter goes privately to the
writer, one-way, no threads, no public trace. Reader may optionally leave a
contact line if they want an answer. Migration `0003_letters.sql`:

```sql
CREATE TABLE letters (
  id         TEXT PRIMARY KEY,            -- 22-char random base64url
  work_id    TEXT NOT NULL,               -- cascade handled in deleteWork()
  body       TEXT NOT NULL,               -- cap 4000 chars
  contact    TEXT NOT NULL DEFAULT '',    -- cap 200 chars, optional
  created_at TEXT NOT NULL
);
CREATE INDEX idx_letters_work ON letters (work_id);
```

Abuse posture = the feedback form's: honeypot field ("website"),
min-render-to-submit gate (JS-stamped `ts`, ≥2 s), length caps, optional
Turnstile (same keys + per-page CSP allowance as the report page),
`RL_LETTER` per IP (2/min), per-work cap 500 stored with the oldest evicted.
`letters_open = 0` 404s both the page and the endpoint — the exact 404 an
unknown work produces, no "letters are closed" oracle. On a locked work the
letter page sits behind the password gate too.

**Privacy stance (by decision):**

- NOTHING about the sender is stored beyond what they typed — no IP, no
  hash, no fingerprint (same stance as reports).
- **No Discord forward.** Letters are the author's private mail, not the
  operator's; Discord is never the doorbell here.
- **No admin access.** Letters are private correspondence — the admin
  surface cannot read them; letters appear nowhere in `/api/admin/*`. When
  an operator removal of a work is purged past its grace window (or the
  author unpublishes, or expiry purges), `deleteWork()` deletes the work's
  letters with it — same hygiene as reports.

Letters are readable/deletable from the manage page only
(`GET /api/works/:id/letters` → `{ lettersOpen, letters[] }` newest first,
`DELETE /api/works/:id/letters/:letterId`, `PUT /api/works/:id/letters-open`
`{ open }` — all `X-Manage-Secret`). The author is a private recipient, not
a moderator — but the letter form still notes that hard-line content in
letters can be reported.

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

## Moderation chain (Phase 2) — SHIPPED, shadow mode

Runs **in the shelf Worker** (`src/worker/lib/moderation.ts`; client-side
previews are courtesy only — the Worker's verdict is the real one). Shipped
in **shadow mode**: the chain runs in the background (`ctx.waitUntil`) AFTER
a successful publish or update — content is already stored and baked, the
HTTP response already decided — and it never blocks anything. Unset
`ANTHROPIC_API_KEY` = complete no-op. **Phase 3 flipped shadow → gate for
listings only** (the shelf listing is the moderation gate, per D6): the same
chain (`runChainVerdict`) now decides listing requests, while publish/update
runs stay shadow.

1. **Chunking** — block contents concatenated in reading order (chapter
   order, block order — same ordering as the tombstone content hash) into
   ~6,000-char chunks with block-id boundaries preserved (each chunk knows
   which block ids it covers; an oversized block is sliced, every slice
   keeping its id). Hard cap **30 chunks per work**: larger works keep the
   first 20 plus a sample of 10 from the rest drawn by a PRNG **seeded by
   the work id** (deterministic per work), and the verdict records
   `truncated: true`.
2. **Router pass** — `claude-haiku-4-5` (the current small/fast tier),
   batches of up to 8 chunks per call, forced tool use so the reply is
   strict JSON `{chunk, flags[]}`. Categories: minors ·
   real-person-harassment · sexual-explicit · graphic-violence · self-harm.
   The rubric states explicitly that fiction is expected and dark themes are
   not flags — it routes for review, it does not judge.
3. **Verifier pass** — `claude-sonnet-5` (stronger tier), **one** call, only
   when a hard-line category was flagged or the aggregate content flags
   aren't covered by the declared rating/warnings. Gets the flagged chunk
   texts plus the declared labels; answers exactly two questions via forced
   tool use: (a) `hardLine: none | minors | real-person-harassment` with a
   quote-grounded one-sentence reason, (b) `labels: honest | under-labeled`
   with suggested `{rating, warnings}`. Instructed never to judge literary
   merit or themes.
4. **Verdict** — compact JSON in `works.moderation_verdict` (+
   `moderation_at`):
   `{ outcome: 'pass'|'tag-fix'|'hold'|'error', truncated, flaggedChunks,
   suggested?, reason?, model, ms }`. `hold` ⇔ hardLine ≠ none; `tag-fix` ⇔
   under-labeled. The write is a plain UPDATE — a work unpublished mid-run
   matches zero rows, silently. Never auto-reject, never auto-publish: a
   hold is a Discord ping for a human, nothing else.
5. **Shadow reporting** — outcomes ≠ `pass` post a compact Discord embed
   (work id, title, outcome, reason/suggestion, explicit "SHADOW MODE —
   nothing was blocked" footer). Pass outcomes live in D1 only, no noise.
   The admin overview/detail and console surface the verdict per work
   (hold = ember, tag-fix = amber, pass = muted, error = muted italic).
6. **Failure posture** — any API error, overall ~60s timeout (AbortSignal),
   or parse failure collapses into an `{outcome:'error', reason}` verdict;
   nothing ever rejects out of the `waitUntil`, and the publish response is
   never affected (it already returned).
7. **Budget guards — three layers** (shipped 2026-07-06, migration
   `0006_budget.sql`), from outermost to innermost:
   1. **Per-IP rate limits** on every write route (the existing outer
      guard) — nobody triggers chain runs faster than the publish/manage
      limits allow.
   2. **Content-hash dedup** — the same prose never pays twice.
      `works.content_hash` stores the bundle's prose hash (the exact
      tombstone recipe, computed once per publish/update and shared with the
      tombstone gate). An update whose hash, rating, AND warnings match the
      stored row while a verdict exists skips the shadow chain entirely
      (labels are verdict inputs — "is this honestly labeled?" — so a
      same-prose relabel re-runs; `relabelWork` also NULLs the hash for the
      same reason). The listing gate REUSES the stored verdict when it is a
      real chain outcome (`pass`/`tag-fix`/`hold` — never `error`/`skipped`)
      and the hash still matches the stored bundle; the mapped
      `listing_verdict` then records `reused: true` and no API call happens.
      `NULL` hash (pre-0006 rows) = unknown → run the chain; hashes backfill
      on the next publish/update, no data migration.
   3. **Global daily run cap** — a settings counter
      (`chain_runs_{YYYY-MM-DD}`, UTC-keyed, atomic upsert-RETURNING) is
      checked-and-incremented BEFORE any Anthropic call, against
      `CHAIN_DAILY_CAP` (plain wrangler var, parsed int, default 100,
      clamped 1..10000). Failed runs still count — error loops can't burn
      free retries. **Fail-safe degradation:** over budget, shadow runs
      store `{outcome:'skipped', reason:'daily budget reached'}` with no
      Discord noise, and listing requests fall back to the no-key manual
      path (`held`, `{reason:'manual'}`, Discord "manual review (chain
      budget reached)"). Budget exhaustion never grants a listing and never
      blocks link-publishing.

   Operator-side recommendation: also set a **monthly spend limit in the
   Anthropic console** — the code caps are the belt, the console limit is
   the braces. The admin overview carries
   `chainBudget: { cap, usedToday }` and the console's stats row shows
   "chain today used/cap".

Phase 3 shipped the author-facing `tag-fix` outcome for listings: the
suggestion lands in `listing_verdict` and the manage page offers one-click
"accept suggested labels & retry" (see the Phase 3 section). Block-anchored
excerpts in that report remain future polish; shadow-run suggestions on
plain publishes stay operator-visible only.

Cost: Haiku-class routing + one Sonnet verification on the rare flagged work
≈ low single-digit cents per novel. With the three budget layers above, the
worst day costs at most `CHAIN_DAILY_CAP` chain runs regardless of traffic.

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
| `/api/admin/works/:id/listing` | POST | **(Phase 3)** `{ action: 'approve' \| 'deny' }` a held/pending listing request |
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

## Phase 3 — the shelf (SHIPPED)

The public browse page and the listing gate. The Phase 2 chain is now a
**hard gate for listings** (design D6: the shelf listing is the moderation
gate) while remaining shadow-only for plain publishes and updates —
link-shares still skip moderation entirely.

### Listing lifecycle

Migration `0005_shelf.sql`: `works.listing_state`, `works.listed_at`,
`works.listing_verdict`, index `idx_works_shelf (listed, status, listed_at)`.
Invariant: `listed = 1` iff `listing_state = 'listed'`.

```
                 PUT listing {list:true}
  NULL ────────────────────────────────► pending ──┬─ chain pass ──► listed
  (never                                 (gate     ├─ chain tag-fix ► refused {reason:'labels', suggested}
  requested)                             running)  ├─ chain hold ───► held    {reason:'review'}  + Discord
    ▲                                              ├─ chain error ──► held    {reason:'error'}   + Discord
    │                                              └─ no API key ───► held    {reason:'manual'}  + Discord
    │
    └── PUT listing {list:false} — ALWAYS allowed, from any state
        (delist / withdraw); operator removal also delists.

  held ── admin approve ──► listed          refused ── author retries ──► pending
       └─ admin deny ─────► refused {reason:'operator'}
```

- **`PUT /api/works/:id/listing`** `{ list: boolean }` (manage secret).
  `list:false` delists immediately, always. `list:true` requires an active,
  non-password-locked work (409 `password_locked` — a public listing nobody
  can open is a support burden); sets `pending` and schedules the gate via
  `ctx.waitUntil`. Re-requests while listed/pending/held are idempotent
  no-ops (no gate re-run, no Discord spam).
- **The gate** (`src/worker/lib/listing.ts`) re-runs the Phase 2 chain
  against the **stored** bundle and maps the verdict: `pass` → listed +
  informational Discord embed ("Listed on the Shelf" — early-days
  visibility); `tag-fix` → refused with the author-facing
  `listing_verdict = { reason: 'labels', suggested }`, **no Discord** (the
  fix is the author's); `hold` → held (`reason: 'review'`) + "LISTING HELD —
  needs your decision" embed; `error` → held (`reason: 'error'`) + embed —
  **fail safe: a broken chain never grants a listing, a human decides.**
  Every gate write is guarded on `listing_state = 'pending'`, so an author
  who delists or unpublishes mid-run beats a slow chain (and the Discord
  ping is skipped with the write).
- **No-key fallback (documented behavior):** without `ANTHROPIC_API_KEY`
  every `list:true` lands as held with `{ reason: 'manual' }` plus a
  "LISTING REQUEST — manual review" embed; the operator approves/denies from
  the admin console. The shelf works chain-less, just slower.
- **Author label-accept flow:** `GET /api/works/:id` (meta) now carries
  `listingState` + parsed `listingVerdict` + `listedAt`. On a
  `reason:'labels'` refusal the manage page shows the suggested labels with
  one button: **`PUT /api/works/:id/labels`** `{ rating, warnings }`
  (author-authorized twin of the admin relabel — same fixed-vocabulary
  validation, same bundle-mutate + full re-bake via the shared
  `src/worker/lib/relabel.ts`), then re-requests the listing. The second
  chain run sees honest labels and passes without a verifier call.
- **Admin:** `POST /api/admin/works/:id/listing` `{ action: 'approve' |
  'deny' }` on held/pending requests — approve mirrors a chain pass, deny
  lands as refused `{ reason: 'operator' }`. The overview surfaces held
  requests as a **"Needs decision"** queue at the top of `/admin` with
  Approve/Deny buttons, and every work row shows its `listing_state`.
  Operator removal (`/remove`) also delists.
- **Expiry:** listed works are exempt from the purge while listed (the
  Phase 1 `listed = 0` purge filter, now actually reachable); delisting
  re-arms the ordinary `expires_at` clock.

### GET /shelf — the browse page

Worker-rendered **live** (not baked — the listing set changes on every gate
decision), `cache-control: public, max-age=60`. Query: `listed = 1 AND
status = 'active' ORDER BY listed_at DESC`, filters `?rating=` /` ?lang=`,
`?page=` at 24 per page with plain Older/Newer links — **zero JS**.

- Speaks the landing's design language: hearts, serif "The Shelf." wordmark
  (slim top bar linking to `/`), warm-cream tokens, filter chips as plain
  links with the active one filled.
- Cards: generated **typographic cover** (aspect 2/2.9, gradient picked
  deterministically from the work id out of four palettes — violet
  `#6f67d0→#4d468f`, ember `#d0602f→#98371a`, teal `#148578→#0b5c53`, deep
  violet `#8a84dd→#5c54b8` — serif title + uppercase pen name inside), then
  serif title, italic two-line-clamped `first_line`, rating badge +
  "+N warnings" (count only, never the list), tabular word count, language
  tag when ≠ `en`. Cards link to `/w/:id`. Explicit-rated cards get the
  synopsis-free treatment: no prose teaser, the badge speaks; the work page
  still gates.
- **No metrics, reaffirmed:** no view counts, no rankings, no "trending" —
  anywhere on the shelf, ever. Recency and filters only; the shelf is a
  library table, not a leaderboard.
- **Indexability:** `/shelf` is the ONE indexable route — it skips both the
  `x-robots-tag` header (opt-out in `withBaseHeaders`, same passthrough
  pattern as the Turnstile CSP) and the robots meta, and carries a proper
  meta description. `/w/*` stays `noindex, nofollow` regardless of rating.
- Landing gains the quiet "Browse the Shelf" link; landing + `/rules`
  (en+hu) explain that listing is the moment of moderation.

## Reuse map

| Built in Phase 1 | Phase 3 reuse (as shipped) |
|---|---|
| Worker skeleton, limits, secrets | unchanged (listing rides `RL_MANAGE`) |
| R2 layout + D1 schema | + `listing_state`/`listed_at`/`listing_verdict` + shelf index + one query |
| Baked reading pages | linked as-is from shelf cards |
| Manage lifecycle, expiry, report, kill switch | + listing section on the manage page; listed works exempt from expiry |
| Publish modal + rating/tags metadata | listing is requested post-publish from the manage surface (checkbox in the publish modal = InkMirror-side follow-up) |
| Moderation chain (shadow) | reused verbatim as the listing gate (`runChainVerdict`); still shadow for publish/update |

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
4. **Phase 3 — SHIPPED:** browse page + listing lifecycle + gate flip (for
   listings; publish/update stays shadow). See the Phase 3 section above.

## Security hardening (external review, 2026-07-06)

An external security review found real issues, all addressed:

- **A public listing binds to the exact reviewed artifact.** Any author
  content update on a listed/pending/held work atomically delists it (one
  UPDATE; response `{ delisted: true }`); an author label change delists too
  (the operator relabel does not — the operator is the moderator); setting a
  password on a listed work is refused (409 `listed`). Enforced in the db
  accessor layer, not just routes.
- **Verdicts are fingerprinted.** `verdict_fingerprint = content_hash |
  rating | normalized-warnings` of the reviewed bundle. The listing gate
  reuses a verdict only on an exact fingerprint match; `setModerationVerdict`
  is guarded `WHERE content_hash = reviewedHash` so a late chain run for
  superseded content no-ops; a changed update NULLs the stale verdict +
  fingerprint. Closes the publish-benign-then-swap laundering path.
- **The validator is a sanitizer.** `sanitizePublishBundle` constructs a
  fresh bundle with only allowlisted, type-checked, length-capped fields;
  unknown fields cannot reach R2. Rejects duplicate ids and metadata-type
  mismatch; caps scene fields + parenthetical (fixes a render `.trim()` crash
  on a non-string scene field); keeps the loud tripwire on the known
  unstripped-backup signal.
- **Truncated reviews never auto-list** — a sampled long work is held for a
  human (the omitted spans are where hidden content would sit).
- **Password-locked works are private and never sent to Anthropic**, and
  cannot be listed. (Also in the rules page.)
- **Reports/letters** reject nonexistent/inactive works before any write or
  Discord ping; the render-gate timestamp must be an integer 2s–24h old
  (closing the `ts=0` bypass); body caps measure actual bytes.
- **Non-atomic R2/D1 accepted, reconciled.** D1 gates every read, so an
  orphaned R2 object is litter, not exposure. The daily cron sweeps orphans
  and runs a listing-invariant canary (alerts, no auto-fix). Versioned R2
  prefixes deferred until scale demands.

## Open questions

1. Does the baked page need an "export as EPUB" button for readers, or is
   that scope creep? (Lean: creep — later.)
2. Pen-name collisions are possible by design (no accounts). Acceptable?
   (Lean: yes — like book covers in the real world.)
3. Should `hu` works get a `lang="hu"` + Hungarian chrome automatically from
   `language`? (Lean: yes, trivial via existing i18n dictionaries.)
4. ~~Worker code layout~~ — resolved: separate repo (`inkmirror-shelf`),
   see D2. Remaining sub-question: final repo/product name.
