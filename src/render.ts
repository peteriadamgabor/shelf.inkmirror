/**
 * Baked reading-page renderer. Called once at publish/update time; the
 * output HTML is stored in R2 and served as-is (D4 in the design spec).
 *
 * Single-chapter works bake to one page (works/{id}/index.html) exactly as
 * before. Multi-chapter works bake N+1 pages: a cover (title, labels,
 * synopsis, front-matter prose, "Continue reading" slot, TOC) plus one page
 * per body chapter (standard + back matter, reading order) at
 * works/{id}/ch/{n}.html.
 *
 * Security posture: every user-controlled string is escaped at the point of
 * interpolation. Character colors are validated against a strict hex regex
 * before they may enter a style attribute — anything else falls back to the
 * teal accent token. Every page carries noindex/nofollow and (for mature/
 * explicit ratings) a localStorage-backed age gate — chapter pages too,
 * because deep links must gate.
 */

import type {
  Mark,
  PublishBundleV1,
  PublishedBlock,
  PublishedChapter,
  Rating,
  WarningTag,
} from './format';
import { escapeHtml, FAVICON_DATA_URI, THEME_CSS } from './html';
import { langForWork, t, type Lang } from './worker/i18n';

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/** Works can be written in any language; right-to-left scripts flip the page. */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'dv', 'yi']);
const FALLBACK_ACCENT = 'var(--teal)';
const POV_ACCENT = 'var(--violet)';

const FRONT_MATTER = new Set<string>(['cover', 'dedication', 'epigraph']);
const BACK_MATTER = new Set<string>(['acknowledgments', 'afterword']);

// Warning + rating labels now live in the i18n dictionary (worker/i18n.ts),
// keyed by the work's language so a Hungarian novel gets Hungarian chrome.

// ---------- derived metadata (shared with the publish route) ----------

/** Word count across all published prose (text + dialogue + scene blocks). */
export function countWords(bundle: PublishBundleV1): number {
  let n = 0;
  for (const b of bundle.blocks) {
    const t = b.content.trim();
    if (t.length === 0) continue;
    n += t.split(/\s+/).length;
  }
  return n;
}

/**
 * Shelf-card teaser: the first sentence (or first 140 chars) of the first
 * non-empty text/dialogue block in the first standard chapter.
 */
export function firstLine(bundle: PublishBundleV1): string {
  const chapters = [...bundle.chapters]
    .filter((c) => c.kind === 'standard')
    .sort((a, b) => a.order - b.order);
  for (const ch of chapters) {
    const blocks = bundle.blocks
      .filter((b) => b.chapter_id === ch.id && (b.type === 'text' || b.type === 'dialogue'))
      .sort((a, b) => a.order - b.order);
    for (const b of blocks) {
      const text = b.content.replace(/\s+/g, ' ').trim();
      if (text.length === 0) continue;
      const m = text.match(/^[^.!?…]*[.!?…]+["'”’»)]*/);
      const sentence = m ? m[0].trim() : '';
      if (sentence.length > 0 && sentence.length <= 140) return sentence;
      return text.slice(0, 140).trim();
    }
  }
  return '';
}

// ---------- marks ----------

/**
 * Render block content with bold/italic marks. Mark offsets address the RAW
 * content, so escaping first would shift them: instead we split the content
 * at mark boundaries, escape each segment, then wrap. Overlapping marks are
 * handled per-segment (a segment is bold if ANY bold mark covers it).
 */
export function renderMarkedContent(content: string, marks: Mark[] | undefined): string {
  if (!marks || marks.length === 0) return escapeHtml(content);

  const clamp = (n: number): number => Math.max(0, Math.min(n, content.length));
  const boundaries = new Set<number>([0, content.length]);
  for (const m of marks) {
    boundaries.add(clamp(m.start));
    boundaries.add(clamp(m.end));
  }
  const points = [...boundaries].sort((a, b) => a - b);

  let out = '';
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (start === undefined || end === undefined || start >= end) continue;
    let piece = escapeHtml(content.slice(start, end));
    const italic = marks.some((m) => m.type === 'italic' && clamp(m.start) <= start && clamp(m.end) >= end);
    const bold = marks.some((m) => m.type === 'bold' && clamp(m.start) <= start && clamp(m.end) >= end);
    if (italic) piece = `<em>${piece}</em>`;
    if (bold) piece = `<strong>${piece}</strong>`;
    out += piece;
  }
  return out;
}

// ---------- chapter ordering ----------

/**
 * Front matter (cover/dedication/epigraph) → standard → back matter
 * (acknowledgments/afterword), each group sorted by `order` — the same
 * layout rules as InkMirror's exporters.
 */
export function orderChapters(chapters: PublishedChapter[]): PublishedChapter[] {
  const sorted = [...chapters].sort((a, b) => a.order - b.order);
  return [
    ...sorted.filter((c) => FRONT_MATTER.has(c.kind)),
    ...sorted.filter((c) => c.kind === 'standard'),
    ...sorted.filter((c) => BACK_MATTER.has(c.kind)),
  ];
}

/** Should this chapter print its title? Follows InkMirror exporter defaults. */
function showsTitle(ch: PublishedChapter): boolean {
  if (FRONT_MATTER.has(ch.kind)) return ch.export_title === true;
  return ch.export_title !== false;
}

// ---------- blocks ----------

interface RenderCtx {
  characters: Map<string, { name: string; color: string }>;
  povCharacterId: string | null;
}

function speakerAccent(color: string | undefined): string {
  return color !== undefined && COLOR_RE.test(color) ? color : FALLBACK_ACCENT;
}

function renderBlock(b: PublishedBlock, ctx: RenderCtx): string {
  if (b.type === 'dialogue') return renderDialogue(b, ctx);
  if (b.type === 'scene') return renderScene(b);
  return `<p class="para">${renderMarkedContent(b.content, b.marks)}</p>`;
}

function renderDialogue(b: PublishedBlock, ctx: RenderCtx): string {
  // Novel-first: dialogue reads as prose. Attribution lives in the writer's
  // own text ("— felelte Eve…"), so no name pill, no chat bubble, no POV
  // right-alignment — those are editor instruments, not reader furniture
  // (and speaker records are often placeholders never meant to be shown).
  // What remains is a whisper: a thin left accent in the character's color.
  const data = b.metadata.type === 'dialogue' ? b.metadata.data : { speaker_id: '' };
  const speaker = data.speaker_id === '' ? undefined : ctx.characters.get(data.speaker_id);
  const isPov = data.speaker_id !== '' && data.speaker_id === ctx.povCharacterId;
  const accent =
    speaker === undefined ? 'var(--line)' : isPov ? POV_ACCENT : speakerAccent(speaker.color);

  const paren =
    'parenthetical' in data && typeof data.parenthetical === 'string' && data.parenthetical.length > 0
      ? `<div class="paren">${escapeHtml(data.parenthetical)}</div>`
      : '';

  return `<div class="dlg" style="--accent:${accent}">
${paren}<div class="dlg-text">${renderMarkedContent(b.content, b.marks)}</div>
</div>`;
}

function renderScene(b: PublishedBlock): string {
  const data = b.metadata.type === 'scene' ? b.metadata.data : { location: '', time: '' };
  const location = data.location.trim();
  const time = data.time.trim();
  let sep: string;
  if (location.length === 0 && time.length === 0) {
    sep = '·&nbsp;&nbsp;·&nbsp;&nbsp;·';
  } else {
    sep = [location, time].filter((s) => s.length > 0).map(escapeHtml).join(' · ');
  }
  const prose =
    b.content.trim().length > 0
      ? `<p class="para">${renderMarkedContent(b.content, b.marks)}</p>`
      : '';
  return `<div class="scene"><div class="scene-sep" role="separator">${sep}</div>${prose}</div>`;
}

// ---------- chrome pieces ----------

function ratingBadge(rating: Rating, lang: Lang): string {
  return `<span class="badge badge-${rating}">${escapeHtml(t(lang, 'rating.' + rating))}</span>`;
}

function warningChips(warnings: WarningTag[], lang: Lang): string {
  return warnings
    .map((w) => `<span class="chip">${escapeHtml(t(lang, 'warning.' + w))}</span>`)
    .join('');
}

function reportLink(workId: string, lang: Lang): string {
  // The form itself lives on the live Worker page /w/:id/report so it can
  // evolve (fields, optional Turnstile) without re-baking published pages.
  return `<a href="/w/${escapeHtml(workId)}/report" rel="nofollow">${escapeHtml(t(lang, 'read.foot.report'))}</a>`;
}

function letterLink(workId: string, lang: Lang): string {
  // Live page, same pattern as the report link. Always baked in: bake time
  // cannot know the future letters_open state, so the link is permanent and
  // the live page simply 404s while the author's mailbox is closed.
  return `<a href="/w/${escapeHtml(workId)}/letter" rel="nofollow">${escapeHtml(t(lang, 'read.foot.letter'))}</a>`;
}

function ageGate(bundle: PublishBundleV1, lang: Lang): string {
  return `<div id="age-gate" class="gate">
<div class="gate-card">
<p class="gate-kicker">${escapeHtml(t(lang, 'brand'))}</p>
<h1 class="gate-title">${escapeHtml(bundle.title)}</h1>
<p class="gate-by">${escapeHtml(bundle.pen_name)}</p>
<div class="labels">${ratingBadge(bundle.rating, lang)}${warningChips(bundle.warnings, lang)}</div>
<p class="gate-copy">${escapeHtml(t(lang, 'read.gate.ratedLine'))} <strong>${escapeHtml(t(lang, 'rating.' + bundle.rating))}</strong> ${escapeHtml(t(lang, 'read.gate.adultLine'))}</p>
<button id="age-yes" class="btn btn-primary" type="button">${t(lang, 'read.gate.enter')}</button>
<p><a href="#" id="age-back">${escapeHtml(t(lang, 'read.gate.back'))}</a></p>
<noscript><p class="gate-noscript">${escapeHtml(t(lang, 'read.gate.noscript'))}</p></noscript>
</div>
</div>`;
}

const AGE_GATE_JS = `(function(){
var KEY='shelf.age.ok';
var gate=document.getElementById('age-gate');
var work=document.getElementById('work');
if(!gate||!work)return;
function open(){gate.hidden=true;work.hidden=false;}
try{if(localStorage.getItem(KEY)==='1'){open();return;}}catch(e){}
var yes=document.getElementById('age-yes');
if(yes)yes.addEventListener('click',function(){try{localStorage.setItem(KEY,'1');}catch(e){}open();});
var back=document.getElementById('age-back');
if(back)back.addEventListener('click',function(e){e.preventDefault();history.back();});
})();`;

// ---------- page CSS (prose layer on top of THEME_CSS) ----------

const READING_CSS = `
/* Reader-adjustable typography. The settings panel writes these custom
   properties on <html>; prose sizes are relative to --rfs so one control
   scales everything. Defaults reproduce the original fixed values. */
:root{--rfs:1;--rmw:42rem;--rlh:1.7;--rfam:var(--serif)}
:root[data-family="sans"]{--rfam:var(--sans)}
/* "Readable" = a dyslexia-comfort mode using system fonts (no webfont to
   download): sans-serif, generous letter + word spacing, and left-aligned,
   never-justified prose — the evidence-based aids (Rello & Baeza-Yates).
   Pairs with the Airy line-spacing and Narrow width controls for the full
   effect. */
:root[data-family="readable"]{--rfam:var(--sans);letter-spacing:.035em;word-spacing:.08em}
:root[data-family="readable"] .para,:root[data-family="readable"] .dlg-text{text-align:left;hyphens:none}
body{position:relative}
/* A whisper of paper grain so the cream surface has depth, not flatness. */
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.028'/%3E%3C/svg%3E")}
main{max-width:var(--rmw);margin:0 auto;padding:0 1.25rem 4rem;position:relative;z-index:1;
  font-family:var(--rfam);font-size:calc(1.0625rem * var(--rfs));line-height:var(--rlh)}
.work-head{padding:3.5rem 0 1rem;text-align:center;border-bottom:1px solid var(--line);margin-bottom:2.5rem}
.work-title{font-family:var(--serif);font-weight:600;font-size:2.1rem;line-height:1.2;margin:0 0 .35rem}
.byline{color:var(--muted);margin:0 0 1rem;font-size:.95rem}
.labels{display:flex;flex-wrap:wrap;gap:.4rem;justify-content:center;margin:0 0 1rem}
.badge,.chip{
  display:inline-block;font-family:var(--sans);font-size:11px;font-weight:600;
  line-height:1;letter-spacing:.13em;text-transform:uppercase;
  padding:5px 10px;border-radius:999px;border:1px solid var(--line);
}
.badge-general{color:var(--muted);background:transparent}
.badge-mature{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 40%,transparent);background:color-mix(in srgb,var(--amber) 10%,transparent)}
.badge-explicit{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 40%,transparent);background:color-mix(in srgb,var(--ember) 10%,transparent)}
.chip{color:var(--muted);letter-spacing:.08em;text-transform:none;font-weight:500}
.synopsis{font-family:var(--serif);font-style:italic;color:var(--muted);margin:.25rem auto 0;max-width:34rem}
.chapter{margin:0 0 3rem}
.ch-title{font-family:var(--serif);font-weight:600;font-size:1.45rem;line-height:1.3;margin:3rem 0 1.4rem;text-align:center}
.ch-center{text-align:center;padding:3.5rem 0}
.ch-center .para{text-align:center}
.ch-cover .para{font-size:1.35rem;line-height:1.5}
.para{
  font-family:inherit;font-size:1em;line-height:inherit;
  margin:0 0 1.1em;white-space:pre-wrap;overflow-wrap:break-word;
}
.scene{margin:2.4em 0 1.2em}
.scene-sep{
  text-align:center;font-family:var(--sans);font-size:.85rem;
  font-variant-caps:all-small-caps;letter-spacing:.14em;color:var(--muted);
  margin:0 0 1.2em;
}
.dlg{margin:0 0 1.1em;padding-left:.9rem;border-left:2px solid color-mix(in srgb,var(--accent) 55%,transparent);--accent:var(--line)}
.paren{font-family:var(--serif);font-style:italic;font-size:.9rem;color:var(--muted);margin:0 0 .2em}
.dlg-text{font-family:inherit;font-size:1em;line-height:inherit;white-space:pre-wrap;overflow-wrap:break-word}
.work-foot{margin-top:3.5rem;padding:0 0 .75rem;text-align:center;font-family:var(--sans);font-size:.8rem;color:var(--muted)}
.foot-mark{font-family:var(--serif);font-size:1rem;color:var(--muted);opacity:.7;margin-bottom:1.1rem}
.foot-meta{margin:0 0 .4rem}
.foot-links{margin:0}
.foot-links a{color:var(--muted);text-decoration:none;border-bottom:1px solid var(--line);padding-bottom:1px;transition:color .15s,border-color .15s}
.foot-links a:hover,.foot-links a:focus{color:var(--violet);border-color:var(--violet)}
.foot-dot{margin:0 .65em;opacity:.6}
.nums{font-variant-numeric:tabular-nums}
.report{margin:1rem 0}
.btn{
  display:inline-block;appearance:none;cursor:pointer;justify-self:start;
  font:600 .85rem/1 var(--sans);padding:.6rem 1rem;border-radius:10px;
  border:1px solid var(--line);background:var(--surface);color:var(--ink);
}
.btn-primary{background:var(--violet);border-color:var(--violet);color:#fff}
.gate{min-height:100vh;display:grid;place-items:center;padding:1.5rem}
.gate-card{
  background:var(--surface);border:1px solid var(--line);border-radius:16px;
  padding:2.2rem 1.8rem;max-width:26rem;text-align:center;
  box-shadow:0 12px 32px rgb(0 0 0 / .08);
}
.gate-kicker{font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 .8rem}
.gate-title{font-family:var(--serif);font-size:1.5rem;line-height:1.25;margin:0 0 .2rem}
.gate-by{color:var(--muted);font-size:.9rem;margin:0 0 1rem}
.gate-copy{font-size:.95rem;margin:1rem 0 1.2rem}
.gate-noscript{font-size:.85rem;color:var(--muted)}
.continue{margin:2.4rem 0 0;text-align:center}
.toc{margin:2.6rem 0 0}
.toc-heading{font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);text-align:center;margin:0 0 .6rem}
.toc-list{list-style:none;margin:0;padding:0}
.toc-list a{
  display:flex;align-items:baseline;gap:.8rem;padding:.7rem .15rem;
  text-decoration:none;color:var(--ink);border-bottom:1px solid var(--line);
  font-family:var(--serif);font-size:1.05rem;
}
.toc-list a:hover .toc-label{color:var(--violet)}
.toc-num{color:var(--muted);font-family:var(--sans);font-size:.8rem;min-width:1.6rem;text-align:right}
.toc-label{flex:1;min-width:0}
.toc-words{color:var(--muted);font-family:var(--sans);font-size:.8rem;white-space:nowrap}
.ch-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:1.4rem 0 .9rem;border-bottom:1px solid var(--line)}
.ch-back{font-family:var(--sans);font-size:.9rem;font-weight:600;text-decoration:none;color:var(--ink)}
.ch-back:hover{color:var(--violet)}
.ch-count{font-family:var(--sans);font-size:.85rem;color:var(--muted)}
.ch-nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;gap:1rem;font-family:var(--sans);font-size:.9rem}
.ch-nav a{text-decoration:none;color:var(--violet)}
.ch-nav .nav-prev{text-align:left}
.ch-nav .nav-toc{text-align:center;color:var(--muted);font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}
.ch-nav .nav-toc:hover,.ch-nav .nav-toc:focus{color:var(--violet)}
.ch-nav .nav-next{text-align:right}
.ch-nav-top{margin:.9rem 0 0}
.ch-nav-bottom{border-top:1px solid var(--line);margin-top:3rem;padding-top:1.2rem}

/* ---------- reading progress + QoL chrome ---------- */
.reading-progress{position:fixed;top:0;left:0;height:3px;width:0;z-index:30;
  background:linear-gradient(90deg,var(--violet),color-mix(in srgb,var(--violet) 70%,var(--ember)));
  transition:width .1s linear}
/* time-left + whole-work % pill, bottom-left; slides away as you read down */
.rmeta{position:fixed;left:1rem;bottom:1rem;z-index:19;font:600 .72rem/1 var(--sans);
  color:var(--muted);background:color-mix(in srgb,var(--surface) 90%,transparent);
  border:1px solid var(--line);border-radius:999px;padding:.45rem .75rem;
  box-shadow:0 2px 10px rgb(0 0 0 / .1);opacity:0;pointer-events:none;
  transform:translateY(.5rem);transition:opacity .22s,transform .22s;font-variant-numeric:tabular-nums}
.rmeta.show{opacity:1;transform:none}
/* back-to-top, above the settings toggle; appears once you're deep in a chapter */
.rbtt{position:fixed;right:1rem;bottom:4.6rem;z-index:19;width:2.6rem;height:2.6rem;
  border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);
  font-size:1.1rem;line-height:1;cursor:pointer;box-shadow:0 4px 14px rgb(0 0 0 / .14);
  opacity:0;pointer-events:none;transform:translateY(.6rem);transition:opacity .2s,transform .2s,color .15s,border-color .15s}
.rbtt.show{opacity:1;pointer-events:auto;transform:none}
.rbtt:hover,.rbtt:focus{color:var(--violet);border-color:var(--violet)}
@media (prefers-reduced-motion: reduce){.reading-progress,.rmeta,.rbtt{transition:none}}

/* ---------- reading settings ---------- */
.rs-toggle{position:fixed;right:1rem;bottom:1rem;z-index:20;width:2.9rem;height:2.9rem;
  border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);
  font:600 1.05rem/1 var(--serif);cursor:pointer;box-shadow:0 4px 14px rgb(0 0 0 / .12);
  transition:transform .12s,box-shadow .15s}
.rs-toggle:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgb(0 0 0 / .16)}
.rs-toggle:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
.rs-panel{position:fixed;right:1rem;bottom:4.4rem;z-index:20;width:17rem;max-width:calc(100vw - 2rem);
  background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:1rem 1.1rem 1.15rem;
  box-shadow:0 14px 40px rgb(0 0 0 / .18);font-family:var(--sans);
  transform-origin:bottom right;transition:opacity .14s,transform .14s}
.rs-panel[hidden]{display:none}
.rs-panel.closing{opacity:0;transform:scale(.96)}
.rs-h{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:.9rem 0 .4rem}
.rs-h:first-child{margin-top:0}
.rs-row{display:flex;gap:.4rem}
.rs-seg{flex:1;display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.rs-seg button{flex:1;appearance:none;border:0;background:transparent;color:var(--ink);
  font:600 .82rem/1 var(--sans);padding:.5rem .3rem;cursor:pointer;transition:background .12s}
.rs-seg button+button{border-left:1px solid var(--line)}
.rs-seg button:hover{background:color-mix(in srgb,var(--violet) 9%,transparent)}
.rs-seg button[aria-pressed="true"]{background:var(--violet);color:#fff}
.rs-size button{font-family:var(--serif)}
.rs-size .s-sm{font-size:.8rem}.rs-size .s-lg{font-size:1.15rem}
.rs-reset{margin-top:.9rem;width:100%;appearance:none;border:1px solid var(--line);border-radius:9px;
  background:transparent;color:var(--muted);font:600 .75rem/1 var(--sans);padding:.5rem;cursor:pointer}
.rs-reset:hover{color:var(--violet);border-color:var(--violet)}
@media (prefers-reduced-motion: reduce){.rs-toggle,.rs-panel{transition:none}}
`;

// ---------- shared page pieces ----------

interface PageMeta {
  id: string;
}

function prepareBlocks(bundle: PublishBundleV1): { ctx: RenderCtx; blocksByChapter: Map<string, PublishedBlock[]> } {
  const characters = new Map(bundle.characters.map((c) => [c.id, { name: c.name, color: c.color }]));
  const ctx: RenderCtx = { characters, povCharacterId: bundle.document.pov_character_id };

  const blocksByChapter = new Map<string, PublishedBlock[]>();
  for (const b of bundle.blocks) {
    const list = blocksByChapter.get(b.chapter_id);
    if (list) list.push(b);
    else blocksByChapter.set(b.chapter_id, [b]);
  }
  for (const list of blocksByChapter.values()) list.sort((a, b) => a.order - b.order);
  return { ctx, blocksByChapter };
}

function chapterSection(ch: PublishedChapter, blocks: PublishedBlock[], ctx: RenderCtx): string {
  const centered = FRONT_MATTER.has(ch.kind);
  const title = showsTitle(ch) && ch.title.trim().length > 0
    ? `<h2 class="ch-title">${escapeHtml(ch.title)}</h2>`
    : '';
  const body = blocks.map((b) => renderBlock(b, ctx)).join('\n');
  const classes = ['chapter', `ch-${ch.kind}`, centered ? 'ch-center' : '']
    .filter((c) => c.length > 0)
    .join(' ');
  return `<section class="${classes}">${title}\n${body}</section>`;
}

function workHeader(bundle: PublishBundleV1, lang: Lang): string {
  const synopsis = bundle.document.synopsis.trim().length > 0
    ? `<p class="synopsis">${escapeHtml(bundle.document.synopsis.trim())}</p>`
    : '';
  return `<header class="work-head">
<h1 class="work-title">${escapeHtml(bundle.title)}</h1>
<p class="byline">${escapeHtml(bundle.pen_name)}</p>
<div class="labels">${ratingBadge(bundle.rating, lang)}${warningChips(bundle.warnings, lang)}</div>
${synopsis}
</header>`;
}

function workFooter(bundle: PublishBundleV1, meta: PageMeta, lang: Lang): string {
  // Closes like a book: centered colophon under an asterism, machinery
  // (report / attribution) whispered on one line.
  return `<footer class="work-foot">
<div class="foot-mark" aria-hidden="true">&#8258;</div>
<p class="foot-meta">${escapeHtml(bundle.pen_name)} &mdash; <span class="nums">${countWords(bundle).toLocaleString('en-US')}</span> ${escapeHtml(t(lang, 'read.foot.words'))}</p>
<p class="foot-links">${letterLink(meta.id, lang)}<span class="foot-dot" aria-hidden="true">&middot;</span>${reportLink(meta.id, lang)}<span class="foot-dot" aria-hidden="true">&middot;</span><a href="https://inkmirror.cc" rel="noopener">${escapeHtml(t(lang, 'read.foot.mark'))}</a></p>
</footer>`;
}

/**
 * Applied in <head> before first paint so a reader's saved preferences never
 * flash the defaults first. Purely reads localStorage → sets attrs/vars on
 * <html>. Wrapped in try/catch (private mode / disabled storage).
 */
const READING_SETTINGS_EARLY = `(function(){try{var d=document.documentElement,s=localStorage;
var fs=s.getItem('shelf.rs.size');if(fs)d.style.setProperty('--rfs',fs);
var fam=s.getItem('shelf.rs.family');if(fam&&fam!=='serif')d.setAttribute('data-family',fam);
var w=s.getItem('shelf.rs.width');if(w)d.style.setProperty('--rmw',w);
var lh=s.getItem('shelf.rs.lh');if(lh)d.style.setProperty('--rlh',lh);
var th=s.getItem('shelf.rs.theme');if(th&&th!=='auto')d.setAttribute('data-theme',th);
}catch(e){}})();`;

function readingSettingsPanel(lang: Lang): string {
  const rs = (k: string): string => escapeHtml(t(lang, 'read.settings.' + k));
  const seg = (group: string, opts: Array<[string, string]>): string =>
    `<div class="rs-seg" data-group="${group}">` +
    opts.map(([val, label]) => `<button type="button" data-val="${val}">${escapeHtml(t(lang, label))}</button>`).join('') +
    `</div>`;
  return `<button class="rs-toggle" id="rs-toggle" type="button" aria-expanded="false" aria-controls="rs-panel" title="${rs('title')}">Aa</button>
<div class="rs-panel" id="rs-panel" hidden role="dialog" aria-label="${rs('title')}">
<div class="rs-h">${rs('size')}</div>
<div class="rs-row"><div class="rs-seg rs-size">
<button type="button" class="s-sm" data-size="dec" aria-label="${rs('smaller')}">A&minus;</button>
<button type="button" data-size="reset" aria-label="${rs('sizeReset')}">A</button>
<button type="button" class="s-lg" data-size="inc" aria-label="${rs('larger')}">A+</button>
</div></div>
<div class="rs-h">${rs('typeface')}</div>
${seg('family', [['serif', 'read.settings.serif'], ['sans', 'read.settings.sans'], ['readable', 'read.settings.readable']])}
<div class="rs-h">${rs('width')}</div>
${seg('width', [['34rem', 'read.settings.narrow'], ['42rem', 'read.settings.normal'], ['52rem', 'read.settings.wide']])}
<div class="rs-h">${rs('spacing')}</div>
${seg('lh', [['1.55', 'read.settings.cozy'], ['1.7', 'read.settings.normal'], ['1.9', 'read.settings.airy']])}
<div class="rs-h">${rs('theme')}</div>
${seg('theme', [['auto', 'read.settings.auto'], ['light', 'read.settings.light'], ['dark', 'read.settings.dark']])}
<button class="rs-reset" id="rs-reset" type="button">${rs('reset')}</button>
</div>`;
}

const READING_SETTINGS_JS = `(function(){
var d=document.documentElement,tog=document.getElementById('rs-toggle'),panel=document.getElementById('rs-panel');
if(!tog||!panel)return;
var SIZES=[.85,1,1.15,1.3,1.5];
function save(k,v){try{localStorage.setItem('shelf.rs.'+k,v);}catch(e){}}
function cur(p,def){var v=getComputedStyle(d).getPropertyValue(p).trim();return v||def;}
function open(){panel.hidden=false;tog.setAttribute('aria-expanded','true');sync();}
function close(){tog.setAttribute('aria-expanded','false');panel.hidden=true;}
tog.addEventListener('click',function(){panel.hidden?open():close();});
document.addEventListener('click',function(e){if(!panel.hidden&&!panel.contains(e.target)&&e.target!==tog)close();});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!panel.hidden)close();});
panel.querySelectorAll('[data-size]').forEach(function(b){b.addEventListener('click',function(){
var act=b.getAttribute('data-size'),v=parseFloat(cur('--rfs','1'))||1;
if(act==='reset')v=1;else{var i=SIZES.indexOf(v);if(i<0)i=1;i+=act==='inc'?1:-1;i=Math.max(0,Math.min(SIZES.length-1,i));v=SIZES[i];}
d.style.setProperty('--rfs',String(v));save('size',String(v));
});});
function applyGroup(g,val){
if(g==='family'){if(val==='serif')d.removeAttribute('data-family');else d.setAttribute('data-family',val);save('family',val);}
else if(g==='width'){d.style.setProperty('--rmw',val);save('width',val);}
else if(g==='lh'){d.style.setProperty('--rlh',val);save('lh',val);}
else if(g==='theme'){if(val==='auto')d.removeAttribute('data-theme');else d.setAttribute('data-theme',val);save('theme',val);}
}
panel.querySelectorAll('[data-group]').forEach(function(seg){var g=seg.getAttribute('data-group');
seg.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){applyGroup(g,b.getAttribute('data-val'));sync();});});});
var reset=document.getElementById('rs-reset');
if(reset)reset.addEventListener('click',function(){
['size','family','width','lh','theme'].forEach(function(k){try{localStorage.removeItem('shelf.rs.'+k);}catch(e){}});
d.removeAttribute('data-family');d.removeAttribute('data-theme');
d.style.removeProperty('--rfs');d.style.removeProperty('--rmw');d.style.removeProperty('--rlh');sync();
});
function sync(){
var map={family:d.getAttribute('data-family')||'serif',theme:d.getAttribute('data-theme')||'auto',width:cur('--rmw','42rem'),lh:cur('--rlh','1.7')};
panel.querySelectorAll('[data-group]').forEach(function(seg){var g=seg.getAttribute('data-group');
seg.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-val')===map[g]));});});
}
})();`;

/**
 * Touch navigation. Two gestures, both reading the rel=prev/next anchors in
 * the chapter nav (no-op on the cover / single-chapter works), RTL-aware, and
 * ignoring anything that starts on a link/control or during text selection:
 *   - SWIPE left/right to turn the page;
 *   - TAP the far-left / far-right screen edge (< 12% / > 88%) to turn the
 *     page, e-reader style. The central reading area never navigates on tap.
 */
const READING_SWIPE_JS = `(function(){
if(!('ontouchstart' in window))return;
var sx=0,sy=0,st=0,ok=false;
function go(sel){var a=document.querySelector(sel);if(a&&a.tagName==='A')location.href=a.getAttribute('href');}
function rtl(){return document.documentElement.getAttribute('dir')==='rtl';}
document.addEventListener('touchstart',function(e){
if(e.touches.length!==1){ok=false;return;}
var tg=e.target;
if(tg&&tg.closest&&tg.closest('.rs-panel,.rs-toggle,.rbtt,.rmeta,a,button,input,textarea,select')){ok=false;return;}
sx=e.touches[0].clientX;sy=e.touches[0].clientY;st=Date.now();ok=true;
},{passive:true});
document.addEventListener('touchend',function(e){
if(!ok)return;ok=false;
if(String(document.getSelection?document.getSelection():'').length>0)return;
var t=e.changedTouches[0],dx=t.clientX-sx,dy=t.clientY-sy,dt=Date.now()-st,adx=Math.abs(dx),ady=Math.abs(dy);
// Swipe: a decisive horizontal drag.
if(dt<=700&&adx>=70&&adx>=ady*1.7){var f=rtl()?dx>0:dx<0;go(f?'a[rel="next"]':'a[rel="prev"]');return;}
// Tap: barely moved, quick, and landed on a screen edge.
if(dt<=350&&adx<12&&ady<12){var w=window.innerWidth,x=t.clientX;
if(x<w*0.12)go(rtl()?'a[rel="next"]':'a[rel="prev"]');
else if(x>w*0.88)go(rtl()?'a[rel="prev"]':'a[rel="next"]');}
},{passive:true});
})();`;

/**
 * Reading quality-of-life for the long-scroll chapters:
 *   - a top progress bar tracking how far through the chapter you've read;
 *   - EXACT resume — the scroll position is saved (per chapter URL) and
 *     restored on return, so "Continue reading" lands you where you actually
 *     stopped, not at the chapter top. Stored as a fraction so it survives a
 *     text-size change;
 *   - ArrowLeft / ArrowRight turn the page on desktop (RTL-aware), the
 *     keyboard companion to swipe.
 */
const READING_QOL_JS = `(function(){
var doc=document.documentElement,work=document.getElementById('work'),bar=document.getElementById('rprog');
if(!work)return;
var rq=window.__rq||null,WPM=230,KEY='shelf.scroll.'+location.pathname;
var meta=document.getElementById('rmeta'),btt=document.getElementById('rbtt');
function maxScroll(){return doc.scrollHeight-window.innerHeight;}
// EXACT resume: restore after two frames so reader-settings layout has
// settled. Skipped while the age gate hides the prose.
if(!work.hidden){try{var sf=parseFloat(localStorage.getItem(KEY)||'');
if(sf>0&&sf<=1)requestAnimationFrame(function(){requestAnimationFrame(function(){
var m=maxScroll();if(m>40)window.scrollTo(0,sf*m);});});}catch(e){}}
var raf=0,lastY=window.scrollY;
function paint(){raf=0;var m=maxScroll(),y=window.scrollY,f=m>0?Math.min(1,Math.max(0,y/m)):0;
if(bar)bar.style.width=(f*100).toFixed(1)+'%';
try{localStorage.setItem(KEY,f.toFixed(4));}catch(e){}
// time-left in this chapter + progress through the whole work
if(meta&&rq){var chLeft=Math.max(0,Math.round(rq.cw*(1-f)/WPM));
var over=rq.tw>0?Math.round(((rq.pw+rq.cw*f)/rq.tw)*100):0;
meta.textContent=(chLeft<=0?'\\u2713':'~'+chLeft+' '+(rq.ml||'min'))+' \\u00b7 '+over+'%';}
// back-to-top by depth
if(btt)btt.classList.toggle('show',y>window.innerHeight*1.2);
// immersion: the meta pill slides away as you read forward, returns on the way back
if(meta&&rq){if(y>lastY+10)meta.classList.remove('show');else if(y<lastY-10||y<24)meta.classList.add('show');}
lastY=y;}
window.addEventListener('scroll',function(){if(!raf)raf=requestAnimationFrame(paint);},{passive:true});
if(meta&&rq)meta.classList.add('show');
paint();
if(btt)btt.addEventListener('click',function(){try{window.scrollTo({top:0,behavior:'smooth'});}catch(e){window.scrollTo(0,0);}});
// ArrowLeft/Right turn the page (desktop companion to swipe), RTL-aware
document.addEventListener('keydown',function(e){
if(e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;
var tg=e.target;if(tg&&/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))return;
if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
var rtl=doc.getAttribute('dir')==='rtl',fwd=rtl?e.key==='ArrowLeft':e.key==='ArrowRight';
var a=document.querySelector(fwd?'a[rel="next"]':'a[rel="prev"]');
if(a&&a.tagName==='A'){e.preventDefault();location.href=a.getAttribute('href');}
});
// Instant page turns: warm the next/prev chapter into the HTTP cache when idle.
function warm(sel){var a=document.querySelector(sel);if(a&&a.tagName==='A'){try{fetch(a.getAttribute('href'),{credentials:'same-origin'}).catch(function(){});}catch(e){}}}
(window.requestIdleCallback||function(fn){return setTimeout(fn,1400);})(function(){warm('a[rel="next"]');warm('a[rel="prev"]');});
})();`;

/** Word stats for the time-left / whole-work progress readout. */
interface ReadingStats {
  /** words in THIS chapter */ cw: number;
  /** words in all PRIOR chapters */ pw: number;
  /** total words in the work */ tw: number;
}

/** Wrap page body in the full HTML document, with the age gate when rated. */
function bakedPage(
  bundle: PublishBundleV1,
  opts: { docTitle: string; body: string; script?: string; stats?: ReadingStats },
): string {
  const gated = bundle.rating !== 'general';
  const main = `<main id="work"${gated ? ' hidden' : ''}>
${opts.body}
</main>`;

  const lang = langForWork(bundle.language);
  const statsJs =
    opts.stats !== undefined
      ? `window.__rq=${jsValue({ ...opts.stats, ml: t(lang, 'read.min') })};`
      : '';
  const js = `${statsJs}${gated ? AGE_GATE_JS : ''}${opts.script ?? ''}${READING_SETTINGS_JS}${READING_SWIPE_JS}${READING_QOL_JS}`;
  const script = `<script>${js}</script>\n`;

  const rtl = RTL_LANGUAGES.has(bundle.language.toLowerCase().split('-')[0] ?? '');
  return `<!doctype html>
<html lang="${escapeHtml(bundle.language)}"${rtl ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${FAVICON_DATA_URI}">
<title>${escapeHtml(opts.docTitle)}</title>
<style>${THEME_CSS}${READING_CSS}</style>
<script>${READING_SETTINGS_EARLY}</script>
</head>
<body>
<div class="reading-progress" id="rprog" aria-hidden="true"></div>
${gated ? ageGate(bundle, lang) : ''}
${main}
<div class="rmeta" id="rmeta" aria-hidden="true"></div>
<button class="rbtt" id="rbtt" type="button" aria-label="${escapeHtml(t(lang, 'read.nav.contents'))}" title="&#8593;">&#8593;</button>
${readingSettingsPanel(lang)}
${script}</body>
</html>`;
}

// ---------- chaptered reading ----------

/** Word count for one chapter's published prose (TOC entries). */
function chapterWordCount(blocks: PublishedBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    const t = b.content.trim();
    if (t.length === 0) continue;
    n += t.split(/\s+/).length;
  }
  return n;
}

/** TOC / continue-slot label: the title, or "Chapter N" when hidden/empty. */
function chapterLabel(ch: PublishedChapter, n: number, lang: Lang): string {
  if (showsTitle(ch) && ch.title.trim().length > 0) return ch.title.trim();
  // Hungarian orders the ordinal before the noun ("3. fejezet"); English after.
  return lang === 'hu' ? `${n}. ${t(lang, 'read.chapterN')}` : `${t(lang, 'read.chapterN')} ${n}`;
}

/** Serialize a value into inline JS, safe against </script> breakout. */
function jsValue(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

function coverPage(
  bundle: PublishBundleV1,
  meta: PageMeta,
  front: PublishedChapter[],
  body: PublishedChapter[],
  labels: string[],
  ctx: RenderCtx,
  blocksByChapter: Map<string, PublishedBlock[]>,
  lang: Lang,
): string {
  const id = escapeHtml(meta.id);
  const frontHtml = front
    .map((ch) => chapterSection(ch, blocksByChapter.get(ch.id) ?? [], ctx))
    .join('\n');

  // Hidden until inline JS finds a stored position — and therefore also
  // hidden under noscript, by construction.
  const continueSlot = body.length > 0
    ? `<div class="continue" id="continue" hidden>
<a id="continue-link" class="btn btn-primary" href="/w/${id}/1">${escapeHtml(t(lang, 'read.toc.continue'))}</a>
</div>`
    : '';

  const minLabel = t(lang, 'read.min');
  const tocEntries = body
    .map((ch, i) => {
      const n = i + 1;
      const words = chapterWordCount(blocksByChapter.get(ch.id) ?? []);
      const mins = Math.max(1, Math.round(words / 230));
      // rel="next" on the first entry lets a forward swipe on the cover open chapter 1.
      return `<li><a href="/w/${id}/${n}"${n === 1 ? ' rel="next"' : ''}><span class="toc-num nums">${n}</span><span class="toc-label">${escapeHtml(labels[i] ?? chapterLabel(ch, n, lang))}</span><span class="toc-words nums">~${mins} ${escapeHtml(minLabel)}</span></a></li>`;
    })
    .join('\n');
  const toc = body.length > 0
    ? `<nav class="toc" id="toc" aria-label="${escapeHtml(t(lang, 'read.toc.heading'))}">
<h2 class="toc-heading">${escapeHtml(t(lang, 'read.toc.heading'))}</h2>
<ol class="toc-list">
${tocEntries}
</ol>
</nav>`
    : '';

  const script = body.length > 0
    ? `(function(){
var el=document.getElementById('continue'),ln=document.getElementById('continue-link');
if(!el||!ln)return;
var id=${jsValue(meta.id)},labels=${jsValue(labels)},pre=${jsValue(t(lang, 'read.toc.continueTo'))};
var n=0;try{n=parseInt(localStorage.getItem('shelf.pos.'+id)||'',10);}catch(e){return;}
if(!n||n<1||n>labels.length)return;
ln.href='/w/'+id+'/'+n;
ln.textContent=pre+' '+labels[n-1];
el.hidden=false;
})();`
    : '';

  const pageBody = `${workHeader(bundle, lang)}
${frontHtml}
${continueSlot}
${toc}
${workFooter(bundle, meta, lang)}`;

  return bakedPage(bundle, {
    docTitle: `${bundle.title} — ${bundle.pen_name}`,
    body: pageBody,
    script,
  });
}

function chapterPage(
  bundle: PublishBundleV1,
  meta: PageMeta,
  ch: PublishedChapter,
  n: number,
  total: number,
  ctx: RenderCtx,
  blocksByChapter: Map<string, PublishedBlock[]>,
  lang: Lang,
  stats: ReadingStats,
): string {
  const id = escapeHtml(meta.id);
  const section = chapterSection(ch, blocksByChapter.get(ch.id) ?? [], ctx);

  const prev = n === 1
    ? `<a class="nav-prev" href="/w/${id}" rel="prev">&larr; ${escapeHtml(t(lang, 'read.nav.cover'))}</a>`
    : `<a class="nav-prev" href="/w/${id}/${n - 1}" rel="prev">&larr; ${escapeHtml(t(lang, 'read.nav.previous'))}</a>`;
  const contents = `<a class="nav-toc" href="/w/${id}#toc">${escapeHtml(t(lang, 'read.nav.contents'))}</a>`;
  const next = n === total
    ? `<span class="nav-next" aria-hidden="true"></span>`
    : `<a class="nav-next" href="/w/${id}/${n + 1}" rel="next">${escapeHtml(t(lang, 'read.nav.next'))} &rarr;</a>`;
  const nav = (cls: string): string =>
    `<nav class="ch-nav ${cls}" aria-label="${escapeHtml(t(lang, 'read.toc.heading'))}">${prev}${contents}${next}</nav>`;

  const head = `<header class="ch-head">
<a class="ch-back" href="/w/${id}">${escapeHtml(bundle.title)}</a>
<span class="ch-count nums">${n} / ${total}</span>
</header>`;

  const pageBody = `${head}
${nav('ch-nav-top')}
${section}
${nav('ch-nav-bottom')}
${workFooter(bundle, meta, lang)}`;

  // Remember the reading position for the cover's "Continue reading" slot.
  const script = `(function(){try{localStorage.setItem('shelf.pos.'+${jsValue(meta.id)},String(${n}));}catch(e){}})();`;

  return bakedPage(bundle, {
    docTitle: `${bundle.title} · ${n} / ${total} — ${bundle.pen_name}`,
    body: pageBody,
    script,
    stats,
  });
}

// ---------- the pages ----------

export interface BakedPages {
  /** works/{id}/index.html — the whole work (single-chapter) or the cover. */
  index: string;
  /** works/{id}/ch/{n}.html for n = index+1 — body chapters in reading order. */
  chapters: string[];
}

/**
 * Render every baked page for a work. A single-chapter work (exactly one
 * chapter after ordering, regardless of kind) keeps the one-page form; a
 * multi-chapter work gets a cover plus one page per standard/back-matter
 * chapter, with front matter rendered on the cover.
 */
export function renderWorkPages(bundle: PublishBundleV1, meta: PageMeta): BakedPages {
  const { ctx, blocksByChapter } = prepareBlocks(bundle);
  const ordered = orderChapters(bundle.chapters);
  const lang = langForWork(bundle.language);

  if (ordered.length === 1) {
    const only = ordered[0];
    const chapterHtml = only ? chapterSection(only, blocksByChapter.get(only.id) ?? [], ctx) : '';
    const words = only ? chapterWordCount(blocksByChapter.get(only.id) ?? []) : 0;
    const pageBody = `${workHeader(bundle, lang)}
${chapterHtml}
${workFooter(bundle, meta, lang)}`;
    const index = bakedPage(bundle, {
      docTitle: `${bundle.title} — ${bundle.pen_name}`,
      body: pageBody,
      stats: { cw: words, pw: 0, tw: words },
    });
    return { index, chapters: [] };
  }

  const front = ordered.filter((ch) => FRONT_MATTER.has(ch.kind));
  const body = ordered.filter((ch) => !FRONT_MATTER.has(ch.kind));
  const labels = body.map((ch, i) => chapterLabel(ch, i + 1, lang));

  // Cumulative word counts feed the per-chapter time-left / whole-work readout.
  const bodyWords = body.map((ch) => chapterWordCount(blocksByChapter.get(ch.id) ?? []));
  const totalWords = bodyWords.reduce((a, b) => a + b, 0);
  let prior = 0;
  const chapters = body.map((ch, i) => {
    const stats: ReadingStats = { cw: bodyWords[i] ?? 0, pw: prior, tw: totalWords };
    prior += bodyWords[i] ?? 0;
    return chapterPage(bundle, meta, ch, i + 1, body.length, ctx, blocksByChapter, lang, stats);
  });

  return {
    index: coverPage(bundle, meta, front, body, labels, ctx, blocksByChapter, lang),
    chapters,
  };
}
