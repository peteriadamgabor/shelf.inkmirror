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
main{max-width:42rem;margin:0 auto;padding:0 1.25rem 4rem}
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
  font-family:var(--serif);font-size:1.0625rem;line-height:1.7;
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
.dlg-text{font-family:var(--serif);font-size:1.0625rem;line-height:inherit;white-space:pre-wrap;overflow-wrap:break-word}
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

/** Wrap page body in the full HTML document, with the age gate when rated. */
function bakedPage(
  bundle: PublishBundleV1,
  opts: { docTitle: string; body: string; script?: string },
): string {
  const gated = bundle.rating !== 'general';
  const main = `<main id="work"${gated ? ' hidden' : ''}>
${opts.body}
</main>`;

  const js = `${gated ? AGE_GATE_JS : ''}${opts.script ?? ''}`;
  const script = js.length > 0 ? `<script>${js}</script>\n` : '';

  const rtl = RTL_LANGUAGES.has(bundle.language.toLowerCase().split('-')[0] ?? '');
  const lang = langForWork(bundle.language);
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
</head>
<body>
${gated ? ageGate(bundle, lang) : ''}
${main}
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

  const wordsLabel = t(lang, 'read.foot.words');
  const tocEntries = body
    .map((ch, i) => {
      const n = i + 1;
      const words = chapterWordCount(blocksByChapter.get(ch.id) ?? []);
      return `<li><a href="/w/${id}/${n}"><span class="toc-num nums">${n}</span><span class="toc-label">${escapeHtml(labels[i] ?? chapterLabel(ch, n, lang))}</span><span class="toc-words nums">${words.toLocaleString('en-US')} ${escapeHtml(wordsLabel)}</span></a></li>`;
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
    const chapterHtml = ordered
      .map((ch) => chapterSection(ch, blocksByChapter.get(ch.id) ?? [], ctx))
      .join('\n');
    const pageBody = `${workHeader(bundle, lang)}
${chapterHtml}
${workFooter(bundle, meta, lang)}`;
    const index = bakedPage(bundle, {
      docTitle: `${bundle.title} — ${bundle.pen_name}`,
      body: pageBody,
    });
    return { index, chapters: [] };
  }

  const front = ordered.filter((ch) => FRONT_MATTER.has(ch.kind));
  const body = ordered.filter((ch) => !FRONT_MATTER.has(ch.kind));
  const labels = body.map((ch, i) => chapterLabel(ch, i + 1, lang));

  return {
    index: coverPage(bundle, meta, front, body, labels, ctx, blocksByChapter, lang),
    chapters: body.map((ch, i) => chapterPage(bundle, meta, ch, i + 1, body.length, ctx, blocksByChapter, lang)),
  };
}
