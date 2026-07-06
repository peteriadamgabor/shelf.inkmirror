/**
 * Letters to the author — the reader side.
 *
 *   GET  /w/:id/letter          live Worker page with the letter form
 *   POST /api/works/:id/letters accept a letter into D1
 *
 * Not comments: one-way, private, no threads, no public trace. The abuse
 * posture is the report form's — rate limit (RL_LETTER per ip) first, then
 * honeypot ("website" stays empty) and the min-render-time gate (`ts`
 * stamped by inline JS; both trip wires answer SUCCESS and store nothing),
 * optional Turnstile when configured, hard caps on body/contact.
 *
 * Privacy stance, by decision: NOTHING about the sender is stored beyond
 * what they typed — no IP, no hash, no fingerprint. NO Discord forward —
 * letters are the author's private mail, not the operator's; they are
 * readable only with the manage secret (see handleManage 'letters').
 * `letters_open = 0` answers the exact 404 an unknown work produces — no
 * oracle saying "this work exists but closed its mailbox".
 *
 * The author side (inbox list / delete / open-close toggle) lives in
 * manage.ts behind X-Manage-Secret.
 */

import type { Env } from '../lib/env';
import { escapeHtml, htmlResponse, pageShell } from '../../html';
import { randomBase64Url } from '../lib/crypto';
import { evictLettersBeyond, insertLetter } from '../lib/db';
import { MAX_REPORT_BODY_BYTES, clientIp, jsonError, readBodyCapped } from '../lib/http';
import { FORM_PAGE_CSS, TURNSTILE_CSP, turnstileEnabled, verifyTurnstile } from './report';
import { getActiveWork, notFoundPage, passwordGate } from './read';

export const MAX_LETTER_BODY = 4000;
export const MAX_LETTER_CONTACT = 200;
/** Per-work storage cap — beyond it the oldest letters are evicted. */
export const LETTERS_PER_WORK_CAP = 500;
const MIN_RENDER_MS = 2000;

interface LetterFields {
  body: string;
  contact: string;
  website: string;
  ts: number;
  turnstileToken: string;
}

async function parseFields(request: Request): Promise<{ fields: LetterFields; isJson: boolean } | null> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  const isJson = contentType.includes('application/json');

  const text = await readBodyCapped(request, MAX_REPORT_BODY_BYTES);
  if (text === null) return null;

  const pick = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const tsRaw = rec['ts'];
    return {
      isJson,
      fields: {
        body: pick(rec['body']),
        contact: pick(rec['contact']),
        website: pick(rec['website']),
        ts: typeof tsRaw === 'number' ? tsRaw : Number(pick(tsRaw)),
        turnstileToken: pick(rec['cf-turnstile-response']),
      },
    };
  }

  const params = new URLSearchParams(text);
  return {
    isJson,
    fields: {
      body: params.get('body') ?? '',
      contact: params.get('contact') ?? '',
      website: params.get('website') ?? '',
      ts: Number(params.get('ts') ?? ''),
      turnstileToken: params.get('cf-turnstile-response') ?? '',
    },
  };
}

function sentPage(workId: string): Response {
  return htmlResponse(
    pageShell({
      title: 'Letter sent — The Shelf',
      body: `<div class="page">
<h1>Sent</h1>
<p>Your letter is on its way to the author.</p>
<p class="muted small">Letters go privately to the writer — one way, no threads, nothing public.</p>
<p><a class="btn" href="/w/${escapeHtml(workId)}">Back to the work</a></p>
</div>`,
    }),
  );
}

export async function handleLetterSubmit(request: Request, env: Env, id: string): Promise<Response> {
  const ip = clientIp(request);
  const rl = await env.RL_LETTER.limit({ key: ip });
  if (!rl.success) return jsonError(429, 'rate_limited');

  const parsed = await parseFields(request);
  if (parsed === null) return jsonError(400, 'invalid_body');
  const { fields, isJson } = parsed;

  // Closed mailbox and unknown work are the SAME 404 — no oracle.
  const row = await getActiveWork(env, id);
  if (row === null || row.letters_open !== 1) {
    return isJson ? jsonError(404, 'not_found') : notFoundPage();
  }

  const ok = (): Response => (isJson ? Response.json({ ok: true }) : sentPage(id));

  // Honeypot filled, or the render-time gate failed → silent success, nothing stored.
  if (fields.website.trim().length > 0) return ok();
  if (!Number.isFinite(fields.ts) || Date.now() - fields.ts < MIN_RENDER_MS) return ok();

  if (turnstileEnabled(env) && !(await verifyTurnstile(env, fields.turnstileToken, ip))) {
    return jsonError(403, 'verification_failed');
  }

  const body = fields.body.trim();
  if (body.length === 0) return jsonError(400, 'empty_letter');
  if (body.length > MAX_LETTER_BODY) return jsonError(400, 'letter_too_long');
  const contact = fields.contact.trim();
  if (contact.length > MAX_LETTER_CONTACT) return jsonError(400, 'contact_too_long');

  await insertLetter(env.SHELF_DB, {
    id: randomBase64Url(16),
    work_id: id,
    body,
    contact,
    created_at: new Date().toISOString(),
  });
  await evictLettersBeyond(env.SHELF_DB, id, LETTERS_PER_WORK_CAP);

  // Deliberately NO Discord forward — the letter is the author's, not ours.
  return ok();
}

// ---------- GET /w/:id/letter — the live letter page ----------

const LETTER_TS_JS = `(function(){var f=document.getElementById('letter-ts');if(f)f.value=String(Date.now());})();`;

/**
 * Worker-rendered (live, not baked) letter page, same pattern as the report
 * page: baked footers only link here, so the form can evolve without
 * re-baking published works. Passes the active-work guard, the password gate
 * (locked works gate their mailbox too), and the letters_open switch —
 * closed answers the styled 404, indistinguishable from no work at all.
 */
export async function letterPage(request: Request, env: Env, id: string): Promise<Response> {
  const row = await getActiveWork(env, id);
  if (row === null) return notFoundPage();
  const gate = await passwordGate(request, row, `/w/${id}/letter`);
  if (gate !== null) return gate;
  if (row.letters_open !== 1) return notFoundPage();
  return buildLetterPage(env, id, row.title, row.pen_name);
}

function buildLetterPage(env: Env, id: string, title: string, penName: string): Response {
  const withTurnstile = turnstileEnabled(env);
  const widget = withTurnstile
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY ?? '')}"></div>`
    : '';
  const head = withTurnstile
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';

  const body = `<div class="page">
<h1>Write to the author</h1>
<p class="work-ref">&ldquo;${escapeHtml(title)}&rdquo; by ${escapeHtml(penName)}</p>
<p class="muted small">Your letter goes privately to the writer — one way, no threads, nothing public.
They only see what you type below.</p>
<form method="post" action="/api/works/${escapeHtml(id)}/letters" class="report-form">
<label>Your letter
<textarea name="body" maxlength="${MAX_LETTER_BODY}" rows="8" required></textarea>
</label>
<label>Where to answer (optional)
<input type="text" name="contact" maxlength="${MAX_LETTER_CONTACT}" placeholder="only if you&#39;d like an answer">
</label>
<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<input type="hidden" name="ts" id="letter-ts" value="">
${widget}
<button type="submit" class="btn">Send letter</button>
</form>
<p class="muted small">Letters that cross a <a href="/rules">hard line</a> can still be reported by their recipient.</p>
<p class="muted small"><a href="/w/${escapeHtml(id)}">Back to the work</a></p>
</div>
<script>${LETTER_TS_JS}</script>`;

  return htmlResponse(
    pageShell({ title: 'Write to the author — The Shelf', css: FORM_PAGE_CSS, body, head }),
    200,
    withTurnstile ? { 'content-security-policy': TURNSTILE_CSP } : undefined,
  );
}
