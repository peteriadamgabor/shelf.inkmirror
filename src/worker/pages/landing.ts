/**
 * GET / — one-screen landing. The Shelf is plumbing plus a reading room;
 * the landing says what it is and points at InkMirror and the rules.
 */

import { htmlResponse, pageShell } from '../../html';

const LANDING_CSS = `
.hero{min-height:80vh;display:grid;place-items:center;text-align:center}
.hero-inner{max-width:34rem;padding:2rem 1.25rem}
.kicker{font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:0 0 1rem}
.hero h1{font-size:2.6rem;margin:0 0 1rem}
.hero p{margin:0 0 1.6rem}
.links{display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap}
`;

export function landingPage(): Response {
  return htmlResponse(
    pageShell({
      title: 'The Shelf',
      css: LANDING_CSS,
      body: `<div class="hero">
<div class="hero-inner">
<p class="kicker">shelf.inkmirror.cc</p>
<h1>The Shelf</h1>
<p>The reading room next door to <a href="https://inkmirror.cc" rel="noopener">InkMirror</a>.
Writers publish a draft or a finished work by explicit choice and share it by unlisted link —
no accounts, no feeds, no algorithm. Works are labeled honestly, read quietly, and expire
after 30 days unless their author renews them.</p>
<div class="links">
<a class="btn btn-primary" href="https://inkmirror.cc" rel="noopener">Write with InkMirror</a>
<a class="btn" href="/rules">House rules</a>
</div>
</div>
</div>`,
    }),
  );
}
