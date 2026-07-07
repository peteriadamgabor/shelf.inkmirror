/**
 * GET / — one-screen landing, speaking InkMirror's hero language: the two
 * hearts, the serif wordmark over its mirrored reflection, the quiet violet
 * CTA. Values are snapshotted from InkMirror's landing (src/routes/landing.tsx
 * there); the reflection keeps scaleY(-1) on the base class so reduced-motion
 * readers still see a mirror, never upright ghost text.
 */

import { escapeHtml, htmlResponse, pageShell } from '../../html';
import { t, type Lang } from '../i18n';

/** Permanent demo work (expiry pinned to 2099; manage link held locally). */
const DEMO_WORK_URL = '/w/wLBzGbzG8TQNhyXftFOz5g';

const LANDING_CSS = `
/* Paper grain — the same surface the reading + browse pages sit on. */
body{position:relative}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.028'/%3E%3C/svg%3E")}
.hero{position:relative;min-height:92vh;display:grid;place-items:center;text-align:center;overflow:hidden}
/* A soft warm bloom behind the wordmark so the composition has a centre of
   gravity instead of floating on flat cream. */
.hero::before{content:"";position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);
  width:min(48rem,92vw);height:32rem;pointer-events:none;z-index:0;
  background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--violet) 13%,transparent),transparent 62%)}
.hero-inner{position:relative;z-index:1;max-width:36rem;padding:2rem 1.25rem;
  animation:hero-rise .7s cubic-bezier(.2,.7,.2,1) both}
@keyframes hero-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.hearts{display:flex;justify-content:center;gap:.75rem;margin-bottom:2rem}
.heart{width:3.5rem;height:3.5rem;border-radius:999px;display:grid;place-items:center;
  box-shadow:0 6px 18px -8px rgb(0 0 0 / .18)}
.heart-core{width:1.75rem;height:1.75rem;border-radius:999px}
.heart-violet{background:color-mix(in srgb,var(--violet) 15%,transparent)}
.heart-violet .heart-core{background:var(--violet);box-shadow:0 0 14px -2px color-mix(in srgb,var(--violet) 60%,transparent)}
.heart-ember{background:color-mix(in srgb,var(--ember) 15%,transparent)}
.heart-ember .heart-core{background:var(--ember);box-shadow:0 0 14px -2px color-mix(in srgb,var(--ember) 55%,transparent)}
.wordmark{position:relative;margin:0 0 1.2rem}
.wordmark h1{font-family:var(--serif);font-weight:600;font-size:clamp(3rem,9vw,4.5rem);letter-spacing:-.02em;line-height:1.1;margin:0}
.mirror-line{width:12rem;height:1px;margin:.5rem auto .25rem;background:linear-gradient(to right,transparent,rgba(127,119,221,.55),transparent)}
.reflection{font-family:var(--serif);font-weight:600;font-size:clamp(3rem,9vw,4.5rem);letter-spacing:-.02em;line-height:1;color:var(--violet);transform:scaleY(-1);filter:blur(.5px);opacity:.5;user-select:none;pointer-events:none;mask-image:linear-gradient(to bottom,rgba(0,0,0,.55) 0%,transparent 80%);-webkit-mask-image:linear-gradient(to bottom,rgba(0,0,0,.55) 0%,transparent 80%);animation:shelf-breath 6s ease-in-out infinite}
@keyframes shelf-breath{0%,100%{opacity:.5}50%{opacity:.4}}
.tagline{font-family:var(--serif);font-size:1.35rem;color:var(--ink);margin:0 0 .75rem;line-height:1.5}
.sub{font-size:1rem;color:var(--muted);max-width:30rem;margin:0 auto 2.4rem;line-height:1.6}
.ctas{display:flex;flex-direction:column;align-items:center;gap:1rem}
@media (min-width:520px){.ctas{flex-direction:row;justify-content:center;gap:1rem}}
.cta-primary,.cta-secondary{display:inline-block;padding:.82rem 1.9rem;border-radius:14px;
  font:500 1.05rem/1.3 var(--sans);text-decoration:none;transition:filter .15s,border-color .15s,transform .1s,box-shadow .15s}
.cta-primary{background:var(--violet);color:#fff;box-shadow:0 10px 26px -8px color-mix(in srgb,var(--violet) 50%,transparent)}
.cta-primary:hover,.cta-primary:focus{filter:brightness(1.08);transform:translateY(-1px)}
.cta-secondary{background:var(--surface);color:var(--ink);border:1px solid var(--line);box-shadow:0 4px 14px -8px rgb(0 0 0 / .22)}
.cta-secondary:hover,.cta-secondary:focus{border-color:var(--violet);color:var(--violet);transform:translateY(-1px)}
.cta-sample{display:inline-block;margin:1.3rem 0 0;font-size:.9rem;color:var(--muted);text-decoration:underline;text-underline-offset:4px;text-decoration-color:var(--line);transition:color .15s}
.cta-sample:hover,.cta-sample:focus{color:var(--violet);text-decoration-color:var(--violet)}
.fine{margin:1.6rem 0 0;font-size:.75rem;color:var(--muted);opacity:.8}
.fine a{color:inherit}
`;

export function landingPage(lang: Lang = 'en'): Response {
  const brand = escapeHtml(t(lang, 'brand'));
  // The tagline/fine strings carry a {token} where a link belongs — the
  // templates are our own trusted strings, so the anchor goes in raw.
  const tagline = t(lang, 'landing.tagline').replace(
    '{ink}',
    '<a href="https://inkmirror.cc" rel="noopener">InkMirror</a>',
  );
  const fine = t(lang, 'landing.fine').replace(
    '{rules}',
    `<a href="/rules">${escapeHtml(t(lang, 'houseRules'))}</a>`,
  );
  return htmlResponse(
    pageShell({
      title: t(lang, 'landing.docTitle'),
      lang,
      css: LANDING_CSS,
      body: `<div class="hero">
<div class="hero-inner">
<div class="hearts" aria-hidden="true">
<div class="heart heart-violet"><div class="heart-core"></div></div>
<div class="heart heart-ember"><div class="heart-core"></div></div>
</div>
<div class="wordmark">
<h1>${brand}</h1>
<div class="mirror-line" aria-hidden="true"></div>
<div class="reflection" aria-hidden="true">${brand}</div>
</div>
<p class="tagline">${tagline}</p>
<p class="sub">${escapeHtml(t(lang, 'landing.sub'))}</p>
<div class="ctas">
<a class="cta-primary" href="https://inkmirror.cc" rel="noopener">${escapeHtml(t(lang, 'landing.ctaWrite'))}</a>
<a class="cta-secondary" href="/shelf">${escapeHtml(t(lang, 'landing.ctaBrowse'))}</a>
</div>
<a class="cta-sample" href="${DEMO_WORK_URL}">${t(lang, 'landing.ctaSample')}</a>
<p class="fine">${fine}</p>
</div>
</div>`,
    }),
  );
}
