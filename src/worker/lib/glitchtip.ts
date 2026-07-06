/**
 * Server-side crash reporting to the self-hosted GlitchTip.
 *
 * The Worker reports its OWN uncaught exceptions — reader browsers are NEVER
 * instrumented, keeping the reading surface private and the baked pages tiny.
 * Because this runs server-side, it needs no tunnel: unlike a browser (which
 * can't attach the NetBird custom header without tripping a CORS preflight),
 * the Worker adds `X-NetBird-Auth` itself and POSTs the envelope straight to
 * GlitchTip's ingest.
 *
 * Privacy: an event carries only the error (type, message, stack), the HTTP
 * method, and the route SHAPE (ids replaced with `:id`) — never the raw URL,
 * query, body, IP, or headers. There is nothing reader-identifying to strip
 * because none of it is collected in the first place.
 *
 * Dormant until GLITCHTIP_DSN is set (like the moderation key).
 */

import type { Env } from './env';

interface Dsn {
  host: string;
  projectId: string;
  publicKey: string;
}

/** Parse a Sentry DSN `https://<key>@<host>/<projectId>`. */
function parseDsn(dsn: string): Dsn | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/\//g, '');
    if (!u.username || !/^\d+$/.test(projectId)) return null;
    return { host: u.hostname, projectId, publicKey: u.username };
  } catch {
    return null;
  }
}

/** Collapse capability ids in a path to `:id` so events group by route. */
function routeShape(path: string): string {
  return path
    .replace(/\/w\/[A-Za-z0-9_-]{22}/g, '/w/:id')
    .replace(/\/works\/[A-Za-z0-9_-]{22}/g, '/works/:id')
    .replace(/\/[0-9]+(?=\/|$)/g, '/:n');
}

/**
 * Report an uncaught Worker exception. Never throws and never rejects — a
 * failed report must not turn one error into two. Call inside ctx.waitUntil.
 */
export async function reportException(
  env: Env,
  error: unknown,
  request: Request,
): Promise<void> {
  try {
    const dsnRaw = env.GLITCHTIP_DSN;
    if (dsnRaw === undefined || dsnRaw.length === 0) return; // dormant
    const dsn = parseDsn(dsnRaw);
    if (dsn === null) return;

    const err = error instanceof Error ? error : new Error(String(error));
    let path = '/';
    let method = 'GET';
    try {
      path = routeShape(new URL(request.url).pathname);
      method = request.method;
    } catch {
      /* keep defaults */
    }

    const eventId = crypto.randomUUID().replace(/-/g, '');
    const sentAt = new Date().toISOString();
    const event = {
      event_id: eventId,
      timestamp: sentAt,
      platform: 'javascript',
      level: 'error',
      logger: 'shelf-worker',
      server_name: 'shelf.inkmirror.cc',
      transaction: `${method} ${path}`,
      exception: {
        values: [
          {
            type: err.name,
            value: err.message.slice(0, 1000),
            stacktrace: err.stack !== undefined ? { frames: framesFromStack(err.stack) } : undefined,
          },
        ],
      },
      // Deliberately NO request body / query / IP / headers / user.
      request: { method, url: `https://shelf.inkmirror.cc${path}` },
    };

    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: sentAt, dsn: dsnRaw }) +
      '\n' +
      JSON.stringify({ type: 'event' }) +
      '\n' +
      JSON.stringify(event);

    const headers: Record<string, string> = { 'content-type': 'application/x-sentry-envelope' };
    if (env.GLITCHTIP_PROXY_AUTH_VALUE !== undefined && env.GLITCHTIP_PROXY_AUTH_VALUE.length > 0) {
      headers[env.GLITCHTIP_PROXY_AUTH_HEADER ?? 'X-NetBird-Auth'] = env.GLITCHTIP_PROXY_AUTH_VALUE;
    }
    const upstream =
      `https://${dsn.host}/api/${dsn.projectId}/envelope/` +
      `?sentry_key=${encodeURIComponent(dsn.publicKey)}&sentry_version=7`;
    const resp = await fetch(upstream, { method: 'POST', headers, body: envelope });
    if (!resp.ok) {
      console.error(`[glitchtip] ingest status=${resp.status}`);
    }
  } catch (e) {
    // A reporting failure must never escalate. Log and move on.
    console.error(`[glitchtip] report failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Best-effort stack → Sentry frames (most-recent-call LAST, per the format). */
function framesFromStack(stack: string): Array<{ function?: string; filename?: string }> {
  const lines = stack.split('\n').slice(1, 41);
  const frames = lines.map((line) => {
    const m = line.match(/at\s+(.+?)\s+\((.+?)\)/) ?? line.match(/at\s+(.+)/);
    if (m === null) return { function: line.trim().slice(0, 200) };
    return { function: (m[1] ?? '').slice(0, 200), filename: (m[2] ?? '').slice(0, 200) };
  });
  return frames.reverse();
}
