/**
 * POST /w/:id/unlock — the password gate's form target.
 *
 * Verifies the submitted password against the stored PBKDF2 hash (constant-
 * time on the derived bytes), rate-limited per (ip, work) via RL_UNLOCK. On
 * success it sets the per-work unlock cookie — base64url(HMAC-SHA256(key:
 * stored password_hash string, message: work id)) — and 303s the reader back
 * to the page they were after (`next`, restricted to paths of the SAME
 * work). Changing or clearing the password rotates the HMAC key, so every
 * outstanding cookie dies with it; there is no session state to clean up.
 *
 * On failure the gate re-serves with a quiet "That's not it." — no oracle
 * about whether the work is locked differently than the reader thinks.
 */

import type { Env } from '../lib/env';
import { unlockCookieName, unlockCookieValue, verifyPassword } from '../lib/password';
import { clientIp, jsonError, readBodyCapped } from '../lib/http';
import { langForWork } from '../i18n';
import { gatePage } from '../pages/gate-page';
import { getActiveWork, notFoundLang, notFoundPage } from './read';

const MAX_UNLOCK_BODY_BYTES = 16 * 1024;
const MAX_NEXT_LENGTH = 200;
export const UNLOCK_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

/** `next` may only point back into the same work's /w/{id}... namespace. */
function sameWorkPath(next: string, id: string): boolean {
  if (next.length === 0 || next.length > MAX_NEXT_LENGTH) return false;
  if (/[\r\n\\]/.test(next)) return false;
  const prefix = `/w/${id}`;
  if (!next.startsWith(prefix)) return false;
  const rest = next.slice(prefix.length);
  return rest === '' || rest.startsWith('/');
}

function seeOther(location: string, setCookie?: string): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  if (setCookie !== undefined) headers.set('set-cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

export async function handleUnlock(request: Request, env: Env, id: string): Promise<Response> {
  const row = await getActiveWork(env, id);
  if (row === null) return notFoundPage(notFoundLang(request));

  const gateWork = {
    id: row.id,
    title: row.title,
    penName: row.pen_name,
    lang: langForWork(row.language),
  };

  const rl = await env.RL_UNLOCK.limit({ key: `${clientIp(request)}:${id}` });
  if (!rl.success) {
    return gatePage(gateWork, { error: 'gate.tooMany', status: 429 });
  }

  // No password on this work — nothing to unlock, just go read it.
  if (row.password_hash === null) return seeOther(`/w/${id}`);

  const text = await readBodyCapped(request, MAX_UNLOCK_BODY_BYTES);
  if (text === null) return jsonError(413, 'too_large');
  const params = new URLSearchParams(text);
  const password = params.get('password') ?? '';
  const next = params.get('next') ?? '';

  if (password.length === 0 || !(await verifyPassword(password, row.password_hash))) {
    return gatePage(gateWork, { next, error: 'gate.wrong', status: 403 });
  }

  const value = await unlockCookieValue(row.password_hash, id);
  const cookie =
    `${unlockCookieName(id)}=${value}; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/w/${id}; Max-Age=${UNLOCK_COOKIE_MAX_AGE_S}`;
  const target = sameWorkPath(next, id) ? next : `/w/${id}`;
  return seeOther(target, cookie);
}
