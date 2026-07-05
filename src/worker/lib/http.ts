/**
 * Shared HTTP helpers: client IP extraction, JSON errors, capped body reads,
 * and CORS for the /api surface (the publish UI lives on inkmirror.cc; the
 * localhost origins cover InkMirror dev servers).
 */

export const MAX_PUBLISH_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_REPORT_BODY_BYTES = 16 * 1024;

/** Only the editor (and its dev servers) may call the API cross-origin. */
export const PUBLISH_ALLOWED_ORIGIN = 'https://inkmirror.cc';

const ALLOWED_ORIGINS = new Set([
  PUBLISH_ALLOWED_ORIGIN,
  'http://localhost:5173',
  'http://localhost:4173',
]);

// 16 random bytes, base64url — 128 bits. The id IS the capability for
// unlisted works, so it gets the same entropy as the sync layer's syncId.
export const WORK_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function clientIp(request: Request): string {
  const raw = request.headers.get('cf-connecting-ip') ?? '';
  // Defensive: only trust IPv4/IPv6 shapes; anything else falls back.
  return /^[0-9a-fA-F:.]+$/.test(raw) && raw.length <= 45 ? raw : 'unknown';
}

export function jsonError(status: number, code: string, detail?: string): Response {
  return Response.json(detail !== undefined ? { error: code, detail } : { error: code }, { status });
}

/**
 * Read a request body with a hard cap, checking Content-Length first so an
 * honest client fails fast, then the actual text length so a lying client
 * can't sneak past the header.
 */
export async function readBodyCapped(request: Request, capBytes: number): Promise<string | null> {
  const cl = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(cl) && cl > capBytes) return null;
  const text = await request.text();
  if (text.length > capBytes) return null;
  return text;
}

/** Reflected-origin CORS headers when the caller is an allowed origin. */
export function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (origin !== null && ALLOWED_ORIGINS.has(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-expose-headers': 'content-type',
      'vary': 'origin',
    };
  }
  return { vary: 'origin' };
}

/** Preflight response for /api routes. */
export function preflightResponse(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeadersFor(request),
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, x-manage-secret',
      'access-control-max-age': '86400',
    },
  });
}

/** Apply CORS headers onto an existing response (for /api routes). */
export function withCors(request: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeadersFor(request))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
