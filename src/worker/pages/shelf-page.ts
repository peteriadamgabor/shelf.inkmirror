/**
 * GET /shelf — the public browse page, Worker-rendered LIVE (not baked): the
 * listing set changes on every gate decision, and a 60s public cache absorbs
 * crowds cheaply.
 *
 * Design: the landing's vocabulary — hearts, serif wordmark, warm cream,
 * quiet chrome. Cards carry a generated typographic cover (no image uploads,
 * by design): a gradient drawn deterministically from the work id, the serif
 * title and small-caps pen name set inside it.
 *
 * Deliberately absent, forever: view counts, rankings, "trending". The shelf
 * sorts by listing recency and filters by rating/language — a library table,
 * not a leaderboard (design spec, "Views" section).
 *
 * This is the ONE page on the domain that search engines may index
 * (CLAUDE.md rule 6): no robots meta here, and src/worker.ts skips the
 * x-robots-tag header for this route only. Zero JS — filters and pagination
 * are plain links.
 */

import { RATINGS, type Rating } from '../../format';
import { escapeHtml, htmlResponse, pageShell } from '../../html';
import type { Env } from '../lib/env';
import { countShelfWorks, listShelfWorks, type ShelfCard, type ShelfFilters } from '../lib/db';

export const SHELF_PAGE_SIZE = 24;
const MAX_PAGE = 10_000;

const RATING_SET = new Set<string>(RATINGS);
const LANG_RE = /^[A-Za-z][A-Za-z0-9-]{0,34}$/;

/** The four cover palettes — violet, ember, teal, deep violet. */
const COVER_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#6f67d0', '#4d468f'],
  ['#d0602f', '#98371a'],
  ['#148578', '#0b5c53'],
  ['#8a84dd', '#5c54b8'],
];

/** FNV-1a over the work id — stable palette pick, nothing cryptographic. */
function coverGradient(workId: string): readonly [string, string] {
  let h = 0x811c9dc5;
  for (let i = 0; i < workId.length; i++) {
    h ^= workId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return COVER_GRADIENTS[(h >>> 0) % COVER_GRADIENTS.length] ?? ['#6f67d0', '#4d468f'];
}

const SHELF_CSS = `
.shelf-page{max-width:64rem;margin:0 auto;padding:0 1.25rem 4rem}
.topbar{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:1.1rem 0;border-bottom:1px solid var(--line)}
.topbar-mark{font-family:var(--serif);font-weight:600;font-size:1.15rem;color:var(--ink);text-decoration:none}
.topbar-mark .dot{color:var(--violet)}
.topbar-links{font-size:.85rem}
.topbar-links a{color:var(--muted);text-decoration:none;border-bottom:1px solid var(--line);padding-bottom:1px}
.topbar-links a:hover,.topbar-links a:focus{color:var(--violet);border-color:var(--violet)}
.shelf-head{text-align:center;padding:2.8rem 0 .4rem}
.shelf-hearts{display:flex;justify-content:center;gap:.5rem;margin-bottom:1.1rem}
.shelf-heart{width:.85rem;height:.85rem;border-radius:999px}
.shelf-heart.violet{background:var(--violet)}
.shelf-heart.ember{background:var(--ember);opacity:.92}
.shelf-head h1{font-family:var(--serif);font-weight:600;font-size:clamp(2.1rem,6vw,2.8rem);letter-spacing:-.02em;margin:0 0 .5rem}
.shelf-head h1 .dot{color:var(--violet)}
.shelf-tag{color:var(--muted);max-width:32rem;margin:0 auto;font-size:1rem}
.shelf-count{color:var(--muted);font-size:.85rem;margin:.6rem 0 0}
.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:.5rem;padding:1.6rem 0 2.2rem}
.chip{display:inline-block;font:500 .82rem/1 var(--sans);letter-spacing:.04em;padding:.5rem .95rem;
  border-radius:999px;border:1px solid var(--line);color:var(--muted);text-decoration:none;
  background:var(--surface);transition:color .15s,border-color .15s}
.chip:hover,.chip:focus{color:var(--violet);border-color:var(--violet)}
.chip.active{background:var(--violet);border-color:var(--violet);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1.6rem 1.4rem}
@media (max-width:560px){.grid{grid-template-columns:repeat(2,1fr);gap:1.3rem .9rem}}
@media (max-width:330px){.grid{grid-template-columns:1fr}}
.wcard{display:block;text-decoration:none;color:var(--ink)}
.cover{aspect-ratio:2/2.9;border-radius:8px;display:flex;flex-direction:column;justify-content:space-between;
  padding:1.1rem .95rem;overflow:hidden;box-shadow:0 6px 18px -8px rgb(0 0 0 / .35);
  transition:transform .18s ease,box-shadow .18s ease}
.wcard:hover .cover,.wcard:focus .cover{transform:translateY(-3px);box-shadow:0 12px 26px -10px rgb(0 0 0 / .4)}
.cover-title{font-family:var(--serif);font-weight:600;color:#fff;font-size:1.05rem;line-height:1.3;
  overflow-wrap:break-word;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.cover-pen{font-family:var(--sans);font-size:.62rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
  color:rgb(255 255 255 / .82);overflow-wrap:break-word}
.card-title{font-family:var(--serif);font-weight:600;font-size:1rem;line-height:1.3;margin:.75rem 0 0;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-first{font-family:var(--serif);font-style:italic;color:var(--muted);font-size:.88rem;line-height:1.45;margin:.3rem 0 0;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;margin:.55rem 0 0}
.badge{display:inline-block;font-family:var(--sans);font-size:10px;font-weight:600;line-height:1;
  letter-spacing:.13em;text-transform:uppercase;padding:4px 8px;border-radius:999px;border:1px solid var(--line)}
.badge-general{color:var(--muted)}
.badge-mature{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 40%,transparent);background:color-mix(in srgb,var(--amber) 10%,transparent)}
.badge-explicit{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 40%,transparent);background:color-mix(in srgb,var(--ember) 10%,transparent)}
.warn-count{font-size:.75rem;color:var(--muted)}
.card-sub{display:flex;align-items:baseline;gap:.6rem;color:var(--muted);font-family:var(--sans);font-size:.75rem;margin:.35rem 0 0}
.lang-tag{font-weight:600;letter-spacing:.1em;text-transform:uppercase;font-size:.68rem;
  border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.empty{text-align:center;color:var(--muted);font-family:var(--serif);font-style:italic;font-size:1.05rem;padding:4rem 0 2rem}
.pager{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:2.6rem 0 0;font-family:var(--sans);font-size:.9rem}
.pager a{color:var(--violet);text-decoration:none}
.pager a:hover,.pager a:focus{text-decoration:underline;text-underline-offset:4px}
.pager .spacer{flex:1}
.shelf-foot{margin-top:3.5rem;padding-top:1rem;border-top:1px solid var(--line);text-align:center;
  font-size:.8rem;color:var(--muted)}
.shelf-foot a{color:var(--muted)}
`;

interface ShelfQuery {
  rating: Rating | null;
  language: string | null;
  page: number;
}

function parseQuery(url: URL): ShelfQuery {
  const ratingRaw = url.searchParams.get('rating');
  const rating = ratingRaw !== null && RATING_SET.has(ratingRaw) ? (ratingRaw as Rating) : null;
  const langRaw = url.searchParams.get('lang');
  const language = langRaw !== null && LANG_RE.test(langRaw) ? langRaw.toLowerCase() : null;
  const pageRaw = url.searchParams.get('page');
  let page = 1;
  if (pageRaw !== null && /^[1-9]\d{0,4}$/.test(pageRaw)) page = Math.min(Number(pageRaw), MAX_PAGE);
  return { rating, language, page };
}

/** /shelf URL for a filter/page combination — page 1 stays clean. */
function shelfUrl(rating: string | null, language: string | null, page: number): string {
  const params = new URLSearchParams();
  if (rating !== null) params.set('rating', rating);
  if (language !== null) params.set('lang', language);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs.length > 0 ? `/shelf?${qs}` : '/shelf';
}

function parseWarningCount(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function chipRow(q: ShelfQuery): string {
  const chips = [
    { label: 'All', rating: null as string | null },
    ...RATINGS.map((r) => ({ label: r.charAt(0).toUpperCase() + r.slice(1), rating: r as string | null })),
  ]
    .map((c) => {
      const active = q.rating === c.rating;
      return `<a class="chip${active ? ' active' : ''}" href="${shelfUrl(c.rating, q.language, 1)}">${c.label}</a>`;
    })
    .join('\n');
  // A language filter arrives by link/URL, not a picker — when active it
  // shows as a removable chip so the reader can see and clear it.
  const lang =
    q.language !== null
      ? `\n<a class="chip active" href="${shelfUrl(q.rating, null, 1)}">Language: ${escapeHtml(q.language.toUpperCase())} &times;</a>`
      : '';
  return `<nav class="chips" aria-label="Filters">\n${chips}${lang}\n</nav>`;
}

function card(w: ShelfCard): string {
  const [from, to] = coverGradient(w.id);
  const warnCount = parseWarningCount(w.warnings);
  const explicit = w.rating === 'explicit';
  // Explicit works get the synopsis-free treatment: no prose teaser on the
  // shelf, the rating badge speaks first. The work page itself still gates.
  const firstLine =
    !explicit && w.first_line.trim().length > 0
      ? `<p class="card-first">${escapeHtml(w.first_line)}</p>`
      : '';
  const warnings = warnCount > 0 ? `<span class="warn-count">+${warnCount} warning${warnCount === 1 ? '' : 's'}</span>` : '';
  const lang =
    w.language.toLowerCase() !== 'en'
      ? `<span class="lang-tag">${escapeHtml(w.language.toUpperCase())}</span>`
      : '';
  return `<a class="wcard" href="/w/${escapeHtml(w.id)}">
<div class="cover" style="background:linear-gradient(160deg,${from},${to})" aria-hidden="true">
<span class="cover-title">${escapeHtml(w.title)}</span>
<span class="cover-pen">${escapeHtml(w.pen_name)}</span>
</div>
<h2 class="card-title">${escapeHtml(w.title)}</h2>
${firstLine}
<div class="card-meta"><span class="badge badge-${escapeHtml(w.rating)}">${escapeHtml(w.rating)}</span>${warnings}</div>
<div class="card-sub"><span class="nums">${w.word_count.toLocaleString('en-US')} words</span>${lang}</div>
</a>`;
}

function pager(q: ShelfQuery, hasOlder: boolean): string {
  if (q.page <= 1 && !hasOlder) return '';
  const newer =
    q.page > 1
      ? `<a href="${shelfUrl(q.rating, q.language, q.page - 1)}" rel="prev">&larr; Newer</a>`
      : '<span></span>';
  const older = hasOlder
    ? `<a href="${shelfUrl(q.rating, q.language, q.page + 1)}" rel="next">Older &rarr;</a>`
    : '<span></span>';
  return `<nav class="pager" aria-label="Pages">${newer}<span class="spacer"></span>${older}</nav>`;
}

export async function shelfPage(url: URL, env: Env): Promise<Response> {
  const q = parseQuery(url);
  const filters: ShelfFilters = { rating: q.rating, language: q.language };

  // Fetch one past the page so "Older" knows whether to exist without a
  // second query; the count feeds the header line.
  const [rows, total] = await Promise.all([
    listShelfWorks(env.SHELF_DB, filters, SHELF_PAGE_SIZE + 1, (q.page - 1) * SHELF_PAGE_SIZE),
    countShelfWorks(env.SHELF_DB, filters),
  ]);
  const hasOlder = rows.length > SHELF_PAGE_SIZE;
  const cards = rows.slice(0, SHELF_PAGE_SIZE);

  const grid =
    cards.length > 0
      ? `<div class="grid">\n${cards.map(card).join('\n')}\n</div>`
      : `<p class="empty">Nothing on this shelf yet &mdash; the books are still being written.</p>`;

  const body = `<div class="shelf-page">
<div class="topbar">
<a class="topbar-mark" href="/">The Shelf<span class="dot">.</span></a>
<span class="topbar-links"><a href="/rules">House rules</a></span>
</div>
<header class="shelf-head">
<div class="shelf-hearts" aria-hidden="true"><span class="shelf-heart violet"></span><span class="shelf-heart ember"></span></div>
<h1>The Shelf<span class="dot">.</span></h1>
<p class="shelf-tag">Works published from the InkMirror editor. Every writer chose to put these here.</p>
<p class="shelf-count nums">${total.toLocaleString('en-US')} work${total === 1 ? '' : 's'}</p>
</header>
${chipRow(q)}
${grid}
${pager(q, hasOlder)}
<footer class="shelf-foot">
<p>Every listed work passed a moderation review at listing time &mdash; labels and legality, never themes.
<a href="/rules">House rules</a> &middot; <a href="https://inkmirror.cc" rel="noopener">Written with InkMirror</a></p>
</footer>
</div>`;

  return htmlResponse(
    pageShell({
      title: 'The Shelf — works published from InkMirror',
      description:
        'Browse works their writers chose to publish from the InkMirror editor — honest labels, quiet reading, no accounts, no feeds, no rankings.',
      indexable: true,
      css: SHELF_CSS,
      body,
    }),
    200,
    // Live-rendered but cheap to keep fresh; 60s absorbs a crowd.
    { 'cache-control': 'public, max-age=60' },
  );
}
