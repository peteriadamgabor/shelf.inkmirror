/**
 * Operator auth for the /api/admin surface.
 *
 * Auth = X-Admin-Secret header compared (as sha256 digests, constant-time)
 * against env.ADMIN_SECRET. When the secret is not configured, or the header
 * is missing/wrong, the caller must answer with the SAME 404 an unknown
 * route produces — the admin surface is not discoverable by probing.
 */

import type { Env } from './env';
import { constantTimeEqualHex, sha256Hex } from './crypto';

export async function adminAuthorized(request: Request, env: Env): Promise<boolean> {
  const configured = env.ADMIN_SECRET;
  if (configured === undefined || configured.length === 0) return false;
  const provided = request.headers.get('x-admin-secret');
  if (provided === null || provided.length === 0 || provided.length > 256) return false;
  const [providedHash, configuredHash] = await Promise.all([sha256Hex(provided), sha256Hex(configured)]);
  return constantTimeEqualHex(providedHash, configuredHash);
}
