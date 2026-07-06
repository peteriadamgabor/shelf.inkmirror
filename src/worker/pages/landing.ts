/**
 * GET / — one-screen landing, speaking InkMirror's hero language: the two
 * hearts, the serif wordmark over its mirrored reflection, the quiet violet
 * CTA. Values are snapshotted from InkMirror's landing (src/routes/landing.tsx
 * there); the reflection keeps scaleY(-1) on the base class so reduced-motion
 * readers still see a mirror, never upright ghost text.
 */

import { htmlResponse, pageShell } from '../../html';

/** Permanent demo work (expiry pinned to 2099; manage link held locally). */
const DEMO_WORK_URL = '/w/wLBzGbzG8TQNhyXftFOz5g';

const LANDING_CSS = `
.hero{min-height:92vh;display:grid;place-items:center;text-align:center;overflow:hidden}
.hero-inner{max-width:36rem;padding:2rem 1.25rem}
.hearts{display:flex;justify-content:center;gap:.75rem;margin-bottom:2rem}
.heart{width:3.5rem;height:3.5rem;border-radius:999px;display:grid;place-items:center}
.heart-core{width:1.75rem;height:1.75rem;border-radius:999px}
.heart-violet{background:color-mix(in srgb,var(--violet) 15%,transparent)}
.heart-violet .heart-core{background:var(--violet)}
.heart-ember{background:color-mix(in srgb,var(--ember) 15%,transparent)}
.heart-ember .heart-core{background:var(--ember)}
.wordmark{position:relative;margin:0 0 1.2rem}
.wordmark h1{font-family:var(--serif);font-weight:600;font-size:clamp(3rem,9vw,4.5rem);letter-spacing:-.02em;line-height:1.1;margin:0}
.mirror-line{width:12rem;height:1px;margin:.5rem auto .25rem;background:linear-gradient(to right,transparent,rgba(127,119,221,.55),transparent)}
.reflection{font-family:var(--serif);font-weight:600;font-size:clamp(3rem,9vw,4.5rem);letter-spacing:-.02em;line-height:1;color:var(--violet);transform:scaleY(-1);filter:blur(.5px);opacity:.5;user-select:none;pointer-events:none;mask-image:linear-gradient(to bottom,rgba(0,0,0,.55) 0%,transparent 80%);-webkit-mask-image:linear-gradient(to bottom,rgba(0,0,0,.55) 0%,transparent 80%);animation:shelf-breath 6s ease-in-out infinite}
@keyframes shelf-breath{0%,100%{opacity:.5}50%{opacity:.4}}
.tagline{font-family:var(--serif);font-size:1.35rem;color:var(--ink);margin:0 0 .75rem;line-height:1.5}
.sub{font-size:1rem;color:var(--muted);max-width:30rem;margin:0 auto 2.4rem}
.ctas{display:flex;flex-direction:column;align-items:center;gap:1.1rem}
@media (min-width:520px){.ctas{flex-direction:row;justify-content:center;gap:1.5rem}}
.cta-primary{display:inline-block;padding:.8rem 2rem;border-radius:14px;background:var(--violet);color:#fff;font:500 1.05rem/1.3 var(--sans);text-decoration:none;box-shadow:0 10px 24px -8px color-mix(in srgb,var(--violet) 45%,transparent);transition:filter .15s}
.cta-primary:hover,.cta-primary:focus{filter:brightness(1.08)}
.cta-quiet{font-size:.9rem;color:var(--muted);text-decoration:underline;text-underline-offset:4px;text-decoration-color:var(--line);transition:color .15s}
.cta-quiet:hover,.cta-quiet:focus{color:var(--violet);text-decoration-color:var(--violet)}
.fine{margin:1.4rem 0 0;font-size:.75rem;color:var(--muted);opacity:.8}
.fine a{color:inherit}
`;

export function landingPage(): Response {
  return htmlResponse(
    pageShell({
      title: 'The Shelf — the reading room next door to InkMirror',
      css: LANDING_CSS,
      body: `<div class="hero">
<div class="hero-inner">
<div class="hearts" aria-hidden="true">
<div class="heart heart-violet"><div class="heart-core"></div></div>
<div class="heart heart-ember"><div class="heart-core"></div></div>
</div>
<div class="wordmark">
<h1>The Shelf</h1>
<div class="mirror-line" aria-hidden="true"></div>
<div class="reflection" aria-hidden="true">The Shelf</div>
</div>
<p class="tagline">The reading room next door to <a href="https://inkmirror.cc" rel="noopener">InkMirror</a>.</p>
<p class="sub">Writers publish a draft or a finished work by explicit choice and share it by
unlisted link — no accounts, no feeds, no algorithm. Works are labeled honestly,
read quietly, and expire after 30 days unless their author renews them.</p>
<div class="ctas">
<a class="cta-primary" href="https://inkmirror.cc" rel="noopener">Write with InkMirror</a>
<a class="cta-quiet" href="${DEMO_WORK_URL}">Read a sample — Rothschild&#39;s Fiddle</a>
</div>
<p class="fine">No accounts. No tracking. <a href="/rules">House rules</a> apply to every shared work.</p>
</div>
</div>`,
    }),
  );
}
