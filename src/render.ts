/**
 * Baked reading-page renderer. Called once at publish/update time; the
 * output HTML is stored in R2 and served as-is (D4 in the design spec).
 *
 * Security posture: every user-controlled string is escaped at the point of
 * interpolation. Character colors are validated against a strict hex regex
 * before they may enter a style attribute — anything else falls back to the
 * teal accent token. The page carries noindex/nofollow and (for mature/
 * explicit ratings) a localStorage-backed age gate.
 */

import type {
  Mark,
  PublishBundleV1,
  PublishedBlock,
  PublishedChapter,
  Rating,
  WarningTag,
} from './format';
import { escapeHtml, THEME_CSS } from './html';

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const FALLBACK_ACCENT = 'var(--teal)';
const POV_ACCENT = 'var(--violet)';

const FRONT_MATTER = new Set<string>(['cover', 'dedication', 'epigraph']);
const BACK_MATTER = new Set<string>(['acknowledgments', 'afterword']);

const WARNING_LABELS: Record<WarningTag, string> = {
  'graphic-violence': 'Graphic violence',
  'sexual-content': 'Sexual content',
  'sexual-violence': 'Sexual violence',
  'self-harm': 'Self-harm / suicide',
  'child-abuse-depiction': 'Child abuse (depiction)',
  'substance-abuse': 'Substance abuse',
  'other': 'Other',
};

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
  const data = b.metadata.type === 'dialogue' ? b.metadata.data : { speaker_id: '' };
  const speaker = data.speaker_id === '' ? undefined : ctx.characters.get(data.speaker_id);
  const isPov = data.speaker_id !== '' && data.speaker_id === ctx.povCharacterId;
  const accent = isPov ? POV_ACCENT : speakerAccent(speaker?.color);

  const pill = speaker
    ? `<span class="pill">${escapeHtml(speaker.name)}</span>`
    : '';
  const paren =
    'parenthetical' in data && typeof data.parenthetical === 'string' && data.parenthetical.length > 0
      ? `<div class="paren">${escapeHtml(data.parenthetical)}</div>`
      : '';

  return `<div class="dlg${isPov ? ' dlg-pov' : ''}" style="--accent:${accent}">
${pill}<div class="bubble">${paren}<div class="dlg-text">${renderMarkedContent(b.content, b.marks)}</div></div>
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

function ratingBadge(rating: Rating): string {
  return `<span class="badge badge-${rating}">${rating}</span>`;
}

function warningChips(warnings: WarningTag[]): string {
  return warnings
    .map((w) => `<span class="chip">${escapeHtml(WARNING_LABELS[w] ?? w)}</span>`)
    .join('');
}

function reportLink(workId: string): string {
  // The form itself lives on the live Worker page /w/:id/report so it can
  // evolve (fields, optional Turnstile) without re-baking published pages.
  return `<p class="report"><a href="/w/${escapeHtml(workId)}/report" rel="nofollow">Report this work</a></p>`;
}

function ageGate(bundle: PublishBundleV1): string {
  return `<div id="age-gate" class="gate">
<div class="gate-card">
<p class="gate-kicker">The Shelf</p>
<h1 class="gate-title">${escapeHtml(bundle.title)}</h1>
<p class="gate-by">by ${escapeHtml(bundle.pen_name)}</p>
<div class="labels">${ratingBadge(bundle.rating)}${warningChips(bundle.warnings)}</div>
<p class="gate-copy">This work is rated <strong>${bundle.rating}</strong> and is intended for adult readers.</p>
<button id="age-yes" class="btn btn-primary" type="button">I&#39;m 18 or older — read</button>
<p><a href="#" id="age-back">Take me back</a></p>
<noscript><p class="gate-noscript">JavaScript is needed to confirm your age for this work. General-rated works on the Shelf read without it.</p></noscript>
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
.dlg{max-width:88%;margin:0 0 1.1em;--accent:var(--teal)}
.dlg-pov{margin-left:auto;text-align:right}
.pill{
  display:inline-block;font-family:var(--sans);font-size:11px;font-weight:600;
  letter-spacing:.1em;text-transform:uppercase;line-height:1;
  color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);
  padding:4px 9px;border-radius:999px;margin:0 0 .35rem;
}
.bubble{
  text-align:left;
  background:color-mix(in srgb,var(--accent) 7%,var(--surface));
  border:1px solid var(--line);border-left:2px solid var(--accent);
  border-radius:12px;padding:.7rem 1rem;
}
.dlg-pov .bubble{border-left:1px solid var(--line);border-right:2px solid var(--accent)}
.paren{font-family:var(--serif);font-style:italic;font-size:.9rem;color:var(--muted);margin:0 0 .3em}
.dlg-text{font-family:var(--serif);font-size:1.0625rem;white-space:pre-wrap;overflow-wrap:break-word}
.work-foot{border-top:1px solid var(--line);margin-top:3rem;padding:1.5rem 0 0;font-size:.85rem;color:var(--muted)}
.work-foot a{color:var(--violet)}
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
`;

// ---------- the page ----------

export function renderWorkPage(bundle: PublishBundleV1, meta: { id: string }): string {
  const characters = new Map(bundle.characters.map((c) => [c.id, { name: c.name, color: c.color }]));
  const ctx: RenderCtx = { characters, povCharacterId: bundle.document.pov_character_id };

  const blocksByChapter = new Map<string, PublishedBlock[]>();
  for (const b of bundle.blocks) {
    const list = blocksByChapter.get(b.chapter_id);
    if (list) list.push(b);
    else blocksByChapter.set(b.chapter_id, [b]);
  }
  for (const list of blocksByChapter.values()) list.sort((a, b) => a.order - b.order);

  const chapterHtml = orderChapters(bundle.chapters)
    .map((ch) => {
      const blocks = blocksByChapter.get(ch.id) ?? [];
      const centered = FRONT_MATTER.has(ch.kind);
      const title = showsTitle(ch) && ch.title.trim().length > 0
        ? `<h2 class="ch-title">${escapeHtml(ch.title)}</h2>`
        : '';
      const body = blocks.map((b) => renderBlock(b, ctx)).join('\n');
      const classes = ['chapter', `ch-${ch.kind}`, centered ? 'ch-center' : '']
        .filter((c) => c.length > 0)
        .join(' ');
      return `<section class="${classes}">${title}\n${body}</section>`;
    })
    .join('\n');

  const synopsis = bundle.document.synopsis.trim().length > 0
    ? `<p class="synopsis">${escapeHtml(bundle.document.synopsis.trim())}</p>`
    : '';

  const header = `<header class="work-head">
<h1 class="work-title">${escapeHtml(bundle.title)}</h1>
<p class="byline">by ${escapeHtml(bundle.pen_name)}</p>
<div class="labels">${ratingBadge(bundle.rating)}${warningChips(bundle.warnings)}</div>
${synopsis}
</header>`;

  const footer = `<footer class="work-foot">
<p>${escapeHtml(bundle.pen_name)} · <span class="nums">${countWords(bundle).toLocaleString('en-US')}</span> words</p>
${reportLink(meta.id)}
<p><a href="https://inkmirror.cc" rel="noopener">Written with InkMirror</a></p>
</footer>`;

  const gated = bundle.rating !== 'general';
  const main = `<main id="work"${gated ? ' hidden' : ''}>
${header}
${chapterHtml}
${footer}
</main>`;

  const script = gated ? `<script>${AGE_GATE_JS}</script>\n` : '';

  return `<!doctype html>
<html lang="${escapeHtml(bundle.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(bundle.title)} — ${escapeHtml(bundle.pen_name)}</title>
<style>${THEME_CSS}${READING_CSS}</style>
</head>
<body>
${gated ? ageGate(bundle) : ''}
${main}
${script}</body>
</html>`;
}
