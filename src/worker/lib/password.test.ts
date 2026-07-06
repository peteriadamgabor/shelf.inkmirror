import { describe, expect, it } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  hashPassword,
  isUnlocked,
  readCookie,
  unlockCookieName,
  unlockCookieValue,
  verifyPassword,
  verifyUnlockCookie,
} from './password';

const WORK = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('PBKDF2 password hashing', () => {
  it('roundtrips: hash then verify', async () => {
    const stored = await hashPassword('open sesame');
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(stored).toContain(`pbkdf2$${PBKDF2_ITERATIONS}$`);
    expect(await verifyPassword('open sesame', stored)).toBe(true);
    expect(await verifyPassword('open sesame!', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts: the same password hashes to different stored strings', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('rejects malformed stored values without throwing', async () => {
    for (const bad of [
      '',
      'plaintext',
      'pbkdf2$100000$onlythree',
      'pbkdf2$100000$a$b$c$d',
      'scrypt$100000$AAAA$BBBB',
      'pbkdf2$NaN$AAAA$BBBB',
      'pbkdf2$0$AAAA$BBBB',
      'pbkdf2$99999999999$AAAA$BBBB', // iteration bomb
      'pbkdf2$100000$$', // empty salt/hash
      'pbkdf2$100000$!!$??', // not base64url
    ]) {
      expect(await verifyPassword('anything', bad), bad).toBe(false);
    }
  });
});

describe('unlock cookie', () => {
  it('is keyed by the stored hash: changing the password invalidates the cookie', async () => {
    const hashA = await hashPassword('first password');
    const hashB = await hashPassword('second password');
    const cookie = await unlockCookieValue(hashA, WORK);
    expect(await verifyUnlockCookie(cookie, hashA, WORK)).toBe(true);
    expect(await verifyUnlockCookie(cookie, hashB, WORK)).toBe(false);
  });

  it('is bound to the work id', async () => {
    const hash = await hashPassword('pw');
    const cookie = await unlockCookieValue(hash, WORK);
    expect(await verifyUnlockCookie(cookie, hash, 'BBBBBBBBBBBBBBBBBBBBBB')).toBe(false);
  });

  it('rejects garbage cookie values without throwing', async () => {
    const hash = await hashPassword('pw');
    for (const bad of ['', 'not base64url!!', 'x'.repeat(200), 'AAAA']) {
      expect(await verifyUnlockCookie(bad, hash, WORK), bad).toBe(false);
    }
  });

  it('readCookie / isUnlocked read the request Cookie header', async () => {
    const hash = await hashPassword('pw');
    const value = await unlockCookieValue(hash, WORK);
    const name = unlockCookieName(WORK);
    const req = new Request('https://shelf.inkmirror.cc/w/x', {
      headers: { cookie: `other=1; ${name}=${value}; last=2` },
    });
    expect(readCookie(req, name)).toBe(value);
    expect(readCookie(req, 'missing')).toBeNull();
    expect(await isUnlocked(req, WORK, hash)).toBe(true);
    expect(await isUnlocked(new Request('https://x.example/'), WORK, hash)).toBe(false);
  });
});
