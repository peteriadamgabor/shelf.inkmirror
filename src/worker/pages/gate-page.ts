/**
 * The password gate page — served in place of content on every reader route
 * of a locked work (/w/:id, /w/:id/:n, /w/:id/report, /w/:id/letter) until
 * the request carries a valid unlock cookie.
 *
 * Same design vocabulary as the age gate: a quiet centered card, serif work
 * title, pen name — plus a lock, a password field, and nothing that leaks
 * content. The form posts to /w/:id/unlock; `next` remembers which page the
 * reader was after (validated server-side to stay inside the same work).
 * Never cached: the response depends on a cookie.
 */

import { escapeHtml, htmlResponse, pageShell } from '../../html';
import { t, type Lang } from '../i18n';

const GATE_CSS = `
.gate{min-height:100vh;display:grid;place-items:center;padding:1.5rem}
.gate-card{
  background:var(--surface);border:1px solid var(--line);border-radius:16px;
  padding:2.2rem 1.8rem;max-width:26rem;width:100%;text-align:center;
  box-shadow:0 12px 32px rgb(0 0 0 / .08);
}
.gate-kicker{font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 .8rem}
.gate-lock{color:var(--muted);margin:0 0 .6rem}
.gate-title{font-family:var(--serif);font-size:1.5rem;line-height:1.25;margin:0 0 .2rem}
.gate-by{color:var(--muted);font-size:.9rem;margin:0 0 1.2rem}
.gate-form{display:grid;gap:.7rem;margin:0 0 1rem}
.gate-form input[type=password]{
  font:inherit;color:var(--ink);background:var(--surface);
  border:1px solid var(--line);border-radius:10px;padding:.6rem .75rem;
  width:100%;text-align:center;
}
.gate-error{color:var(--ember);font-size:.9rem;margin:0 0 .8rem}
.gate-hint{color:var(--muted);font-size:.85rem;margin:0}
`;

const LOCK_SVG =
  '<svg class="gate-lock" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export interface GateWork {
  id: string;
  title: string;
  penName: string;
  /** The work's language → gate chrome locale (a Hungarian work gates in Magyar). */
  lang: Lang;
}

export interface GateOpts {
  /** Same-work path to return to after unlock (validated again on POST). */
  next?: string;
  /** Quiet error line, as an i18n key ('gate.wrong' | 'gate.tooMany'). */
  error?: string;
  status?: number;
}

export function gatePage(work: GateWork, opts: GateOpts = {}): Response {
  const lang = work.lang;
  const id = escapeHtml(work.id);
  const next =
    opts.next !== undefined && opts.next.length > 0
      ? `<input type="hidden" name="next" value="${escapeHtml(opts.next)}">`
      : '';
  // gate.wrong is stored pre-escaped (&#39;), so it goes in raw — every other
  // key is plain text and passes through escapeHtml at the interpolation point.
  const error =
    opts.error !== undefined && opts.error.length > 0
      ? `<p class="gate-error">${t(lang, opts.error)}</p>`
      : '';

  const body = `<div class="gate">
<div class="gate-card">
<p class="gate-kicker">${escapeHtml(t(lang, 'brand'))}</p>
${LOCK_SVG}
<h1 class="gate-title">${escapeHtml(work.title)}</h1>
<p class="gate-by">${escapeHtml(t(lang, 'by'))} ${escapeHtml(work.penName)}</p>
${error}
<form class="gate-form" method="post" action="/w/${id}/unlock">
${next}
<input type="password" name="password" required maxlength="128" autocomplete="current-password" autofocus aria-label="${escapeHtml(t(lang, 'gate.placeholder'))}">
<button type="submit" class="btn btn-primary">${escapeHtml(t(lang, 'gate.unlock'))}</button>
</form>
<p class="gate-hint">${escapeHtml(t(lang, 'gate.hint'))}</p>
</div>
</div>`;

  return htmlResponse(
    pageShell({ title: `${work.title} — ${t(lang, 'brand')}`, lang, css: GATE_CSS, body }),
    opts.status ?? 200,
    { 'cache-control': 'no-store' },
  );
}
