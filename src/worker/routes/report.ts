/**
 * POST /api/works/:id/report — reader reports a rule violation.
 *
 * Same abuse posture as InkMirror's feedback form: rate limit first, then
 * honeypot ("website" must stay empty) and a min-render-time gate (the `ts`
 * field is stamped by inline JS at page load; a submit younger than 2s is a
 * bot). Both trip wires answer with SUCCESS and forward nothing, so bots
 * don't retry.
 *
 * Phase 1.5: every ACCEPTED report is mirrored into D1 (reports table +
 * works.report_count) BEFORE the Discord forward — Discord failing must not
 * lose the record. Nothing about the reporter is stored, by decision.
 * Optionally, when both TURNSTILE_* secrets are set, the submit must carry a
 * valid cf-turnstile-response (the live /w/:id/report page embeds the widget).
 */

import type { Env } from '../lib/env';
import { escapeHtml, htmlResponse, pageShell } from '../../html';
import { randomBase64Url } from '../lib/crypto';
import { incrementReportCount, insertReport } from '../lib/db';
import { MAX_REPORT_BODY_BYTES, clientIp, jsonError, readBodyCapped } from '../lib/http';
import { langForWork, t, type Lang } from '../i18n';
import { workUrl } from './publish';
import { getActiveWork, notFoundLang, notFoundPage, passwordGate } from './read';

/** Render an intro string whose {rules} token expands to the House-rules link. */
function withRulesLink(lang: Lang, key: string): string {
  return t(lang, key).replace(
    '{rules}',
    `<a href="/rules">${escapeHtml(t(lang, 'report.rulesLink'))}</a>`,
  );
}

export const REPORT_REASONS = new Set(['mislabeled', 'hard-line', 'plagiarism', 'other']);
const MAX_MESSAGE = 1000;
const MIN_RENDER_MS = 2000;
const MAX_TS_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The render-to-submit gate. A trustworthy timestamp is an integer at least
 * MIN_RENDER_MS old (bots submit instantly) and no more than a day old (a
 * replayed or absurd value). Missing (NaN), zero, and future timestamps all
 * fall outside the window and are rejected — closing the ts=0 bypass.
 */
export function tsFresh(ts: number): boolean {
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return false;
  const age = Date.now() - ts;
  return age >= MIN_RENDER_MS && age <= MAX_TS_AGE_MS;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileEnabled(env: Env): boolean {
  return (
    env.TURNSTILE_SITE_KEY !== undefined &&
    env.TURNSTILE_SITE_KEY.length > 0 &&
    env.TURNSTILE_SECRET_KEY !== undefined &&
    env.TURNSTILE_SECRET_KEY.length > 0
  );
}

interface ReportFields {
  reason: string;
  message: string;
  website: string;
  ts: number;
  turnstileToken: string;
}

function confirmationPage(workId: string, lang: Lang): Response {
  return htmlResponse(
    pageShell({
      title: `${t(lang, 'report.receivedTab')} — ${t(lang, 'brand')}`,
      lang,
      body: `<div class="page">
<h1>${escapeHtml(t(lang, 'report.thankYou'))}</h1>
<p>${escapeHtml(t(lang, 'report.received'))}</p>
<p class="muted small">${withRulesLink(lang, 'report.confirmIntro')}</p>
<p><a class="btn" href="/w/${escapeHtml(workId)}">${escapeHtml(t(lang, 'backToWork'))}</a></p>
</div>`,
    }),
  );
}

async function parseFields(request: Request): Promise<{ fields: ReportFields; isJson: boolean } | null> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  const isJson = contentType.includes('application/json');

  const text = await readBodyCapped(request, MAX_REPORT_BODY_BYTES);
  if (text === null) return null;

  const pick = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (isJson) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const rec = body as Record<string, unknown>;
    const tsRaw = rec['ts'];
    return {
      isJson,
      fields: {
        reason: pick(rec['reason']),
        message: pick(rec['message']),
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
      reason: params.get('reason') ?? '',
      message: params.get('message') ?? '',
      website: params.get('website') ?? '',
      ts: Number(params.get('ts') ?? ''),
      turnstileToken: params.get('cf-turnstile-response') ?? '',
    },
  };
}

/** Backslash-escape Discord markdown so reporter text can't render as links/mentions. */
function sanitizeMarkdown(s: string): string {
  return s.replace(/[\\*_~`>|[\]()#@]/g, '\\$&');
}

/** POST the token to siteverify; only an explicit success passes. (Shared with the letter flow.) */
export async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (token.length === 0 || token.length > 2048) return false;
  const secretKey = env.TURNSTILE_SECRET_KEY;
  if (secretKey === undefined) return false;
  const params = new URLSearchParams({ secret: secretKey, response: token });
  if (ip !== 'unknown') params.set('remoteip', ip);
  try {
    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!resp.ok) return false;
    const outcome: unknown = await resp.json();
    return (
      typeof outcome === 'object' &&
      outcome !== null &&
      (outcome as Record<string, unknown>)['success'] === true
    );
  } catch {
    return false;
  }
}

export async function handleReport(request: Request, env: Env, id: string): Promise<Response> {
  const ip = clientIp(request);
  const rl = await env.RL_REPORT.limit({ key: ip });
  if (!rl.success) return jsonError(429, 'rate_limited');

  const parsed = await parseFields(request);
  if (parsed === null) return jsonError(400, 'invalid_body');
  const { fields, isJson } = parsed;

  // The confirmation page speaks the work's language; until the row is in hand
  // (bot trip-wires fire first) English is the safe default.
  let lang: Lang = 'en';
  const ok = (): Response => (isJson ? Response.json({ ok: true }) : confirmationPage(id, lang));

  // Honeypot filled, or the render-time gate failed → silent success, nothing stored.
  if (fields.website.trim().length > 0) return ok();
  if (!tsFresh(fields.ts)) return ok();

  // Never insert a report (or ring Discord) for a work that does not exist or
  // is not active — no orphan reports, no oracle (silent success either way).
  const work = await getActiveWork(env, id);
  if (work === null) return ok();
  lang = langForWork(work.language);

  if (turnstileEnabled(env) && !(await verifyTurnstile(env, fields.turnstileToken, ip))) {
    return jsonError(403, 'verification_failed');
  }

  if (!REPORT_REASONS.has(fields.reason)) return jsonError(400, 'invalid_reason');
  const message = fields.message.trim();
  if (message.length > MAX_MESSAGE) return jsonError(400, 'message_too_long');

  // D1 first — the durable record. Discord is only the doorbell.
  await insertReport(env.SHELF_DB, {
    id: randomBase64Url(16),
    work_id: id,
    reason: fields.reason,
    message,
    created_at: new Date().toISOString(),
  });
  await incrementReportCount(env.SHELF_DB, id);

  if (env.DISCORD_WEBHOOK !== undefined && env.DISCORD_WEBHOOK.length > 0) {
    const discordBody = {
      content: '**Shelf report**',
      embeds: [
        {
          title: `Report: ${fields.reason}`,
          description: message.length > 0 ? sanitizeMarkdown(message).slice(0, 2000) : '_no message_',
          color: 0xd85a30,
          fields: [
            { name: 'Work', value: id, inline: true },
            { name: 'URL', value: workUrl(id), inline: false },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
      allowed_mentions: { parse: [] as string[] },
    };

    try {
      const resp = await fetch(env.DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(discordBody),
      });
      if (!resp.ok) console.error(`[report] discord webhook failed status=${resp.status}`);
    } catch (e) {
      console.error(`[report] discord webhook unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return ok();
}

// ---------- GET /w/:id/report — the live report page ----------

const REPORT_TS_JS = `(function(){var f=document.getElementById('report-ts');if(f)f.value=String(Date.now());})();`;

/** Form-page styling, shared with the letter page (same design tokens). */
export const FORM_PAGE_CSS = `
.report-form{display:grid;gap:.8rem;margin:1.2rem 0 0}
.report-form label{display:grid;gap:.3rem;font-size:.9rem}
.report-form select,.report-form textarea,.report-form input[type=text]{
  font:inherit;color:var(--ink);background:var(--surface);
  border:1px solid var(--line);border-radius:8px;padding:.5rem .65rem;
}
.report-form .btn{justify-self:start}
.hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0;pointer-events:none}
.work-ref{color:var(--muted);font-size:.95rem;margin:.2rem 0 0}
`;

/**
 * CSP for the Turnstile-carrying pages only (/w/:id/report, /w/:id/letter):
 * the widget needs its external script and its challenge iframe. Every other
 * page keeps the strict inline-only CSP.
 */
export const TURNSTILE_CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline' https://challenges.cloudflare.com; " +
  "frame-src https://challenges.cloudflare.com; " +
  "connect-src 'self'; " +
  "img-src 'self' data:; " +
  "form-action 'self'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'";

/**
 * Worker-rendered (live, not baked) report page. Newly baked reading pages
 * link here instead of embedding the form, so the form can evolve (fields,
 * Turnstile) without re-baking every published work. Old baked pages still
 * POST their inline form directly to the API — that keeps working.
 */
export async function reportPage(request: Request, env: Env, id: string): Promise<Response> {
  const row = await getActiveWork(env, id);
  if (row === null) return notFoundPage(notFoundLang(request));
  // Locked works gate their report page too — the form names the work.
  const gate = await passwordGate(request, row, `/w/${id}/report`);
  if (gate !== null) return gate;
  return buildReportPage(env, id, row.title, row.pen_name, langForWork(row.language));
}

function buildReportPage(env: Env, id: string, title: string, penName: string, lang: Lang): Response {
  const withTurnstile = turnstileEnabled(env);
  const widget = withTurnstile
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY ?? '')}"></div>`
    : '';
  const head = withTurnstile
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';

  const body = `<div class="page">
<h1>${escapeHtml(t(lang, 'report.title'))}</h1>
<p class="work-ref">&ldquo;${escapeHtml(title)}&rdquo; ${escapeHtml(t(lang, 'by'))} ${escapeHtml(penName)}</p>
<p class="muted small">${withRulesLink(lang, 'report.formIntro')}</p>
<form method="post" action="/api/works/${escapeHtml(id)}/report" class="report-form">
<label>${escapeHtml(t(lang, 'report.reasonLabel'))}
<select name="reason" required>
<option value="mislabeled">${escapeHtml(t(lang, 'report.reasonMislabeled'))}</option>
<option value="hard-line">${escapeHtml(t(lang, 'report.reasonHardLine'))}</option>
<option value="plagiarism">${escapeHtml(t(lang, 'report.reasonPlagiarism'))}</option>
<option value="other">${escapeHtml(t(lang, 'report.reasonOther'))}</option>
</select>
</label>
<label>${escapeHtml(t(lang, 'report.detailsLabel'))}
<textarea name="message" maxlength="1000" rows="5"></textarea>
</label>
<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<input type="hidden" name="ts" id="report-ts" value="">
${widget}
<button type="submit" class="btn">${escapeHtml(t(lang, 'report.submit'))}</button>
</form>
<p class="muted small"><a href="/w/${escapeHtml(id)}">${escapeHtml(t(lang, 'backToWork'))}</a></p>
</div>
<script>${REPORT_TS_JS}</script>`;

  return htmlResponse(
    pageShell({ title: `${t(lang, 'report.tab')} — ${t(lang, 'brand')}`, lang, css: FORM_PAGE_CSS, body, head }),
    200,
    withTurnstile ? { 'content-security-policy': TURNSTILE_CSP } : undefined,
  );
}
