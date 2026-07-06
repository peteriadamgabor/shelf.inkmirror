/**
 * Password tier plumbing (visibility tier 2): PBKDF2-SHA256 password hashing
 * via WebCrypto, and the per-work unlock cookie.
 *
 * Stored hash format: `pbkdf2$<iterations>$<salt-b64url>$<hash-b64url>` in
 * works.password_hash (NULL = no gate).
 *
 * The unlock cookie `shelf_u_{id}` carries
 * base64url(HMAC-SHA256(key: the stored password_hash STRING, message: id)).
 * Keying the HMAC by the stored hash means changing or clearing the password
 * rotates the key and silently invalidates every outstanding cookie — no
 * extra server secret, no session table. Verification recomputes the HMAC
 * and compares constant-time; nothing derived from the password itself ever
 * reaches the reader.
 */

import { constantTimeEqualBytes, fromBase64Url, toBase64Url } from './crypto';

export const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 4;
export const MAX_PASSWORD_LENGTH = 128;

const SALT_BYTES = 16;
const HASH_BITS = 256;
/** Guard against a hostile stored value spinning the Worker. */
const MAX_STORED_ITERATIONS = 10_000_000;

const encoder = new TextEncoder();

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Hash a (length-validated) password with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Constant-time comparison of the derived bytes; malformed stored → false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_STORED_ITERATIONS) {
    return false;
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64Url(parts[2] ?? '');
    expected = fromBase64Url(parts[3] ?? '');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await pbkdf2(password, salt, iterations);
  return constantTimeEqualBytes(derived, expected);
}

// ---------- unlock cookie ----------

export function unlockCookieName(id: string): string {
  // Work ids are base64url (WORK_ID_RE) — every character is cookie-name safe.
  return `shelf_u_${id}`;
}

async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(message)));
}

export async function unlockCookieValue(passwordHash: string, id: string): Promise<string> {
  return toBase64Url(await hmacSha256(passwordHash, id));
}

/** Recompute the HMAC and compare constant-time; malformed value → false. */
export async function verifyUnlockCookie(
  value: string,
  passwordHash: string,
  id: string,
): Promise<boolean> {
  if (value.length === 0 || value.length > 128) return false;
  let provided: Uint8Array;
  try {
    provided = fromBase64Url(value);
  } catch {
    return false;
  }
  const expected = await hmacSha256(passwordHash, id);
  return constantTimeEqualBytes(provided, expected);
}

/** Value of one cookie from the request's Cookie header, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Does this request carry a valid unlock cookie for the work? */
export async function isUnlocked(
  request: Request,
  id: string,
  passwordHash: string,
): Promise<boolean> {
  const value = readCookie(request, unlockCookieName(id));
  if (value === null) return false;
  return await verifyUnlockCookie(value, passwordHash, id);
}
