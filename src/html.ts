/**
 * Shared HTML plumbing: escaping, the design-token stylesheet, and the page
 * shell used by every Worker-generated chrome page (landing, rules, manage,
 * not-found, report confirmation). The baked reading page (src/render.ts)
 * uses the same tokens with its own prose layer on top.
 *
 * The design language is snapshotted from InkMirror's reading surface:
 * serif prose on warm cream, dark mode with the faint violet undertone.
 */

/** Escape a user string for interpolation into HTML text or attributes. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Design tokens — light theme first, dark via prefers-color-scheme.
 * Every page inlines this block; there are no external assets by design
 * (strict CSP: default-src 'none').
 */
export const THEME_CSS = `
:root{
  --bg:#f2efe9;
  --surface:#ffffff;
  --ink:#2d2a26;
  --muted:#7a7266;
  --line:#e3ddd2;
  --violet:#7F77DD;
  --ember:#D85A30;
  --teal:#0d9488;
  --amber:#b45309;
  --serif:'Iowan Old Style','Palatino Linotype','Book Antiqua',Palatino,Georgia,serif;
  --sans:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#1a1723;
    --surface:#241f2d;
    --ink:#e9e5ee;
    --muted:#9b93a9;
    --line:#37304a;
    --violet:#918ae6;
    --ember:#e0693f;
    --teal:#2db5a8;
    --amber:#d98b3a;
  }
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background:var(--bg);
  color:var(--ink);
  font-family:var(--sans);
  line-height:1.7;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--violet)}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}
}
`;

/** Chrome layer for shell pages (not the reading page). */
export const SHELL_CSS = `
.page{max-width:42rem;margin:0 auto;padding:3.5rem 1.25rem 4rem}
.page h1,.page h2,.page h3{font-family:var(--serif);line-height:1.25;font-weight:600}
.page h1{font-size:2rem;margin:0 0 .5rem}
.page h2{font-size:1.35rem;margin:2.5rem 0 .6rem}
.page h3{font-size:1.1rem;margin:1.8rem 0 .4rem}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:1.25rem 1.4rem;margin:1rem 0}
.btn{
  display:inline-block;appearance:none;cursor:pointer;text-decoration:none;
  font:600 .9rem/1 var(--sans);padding:.65rem 1.1rem;border-radius:10px;
  border:1px solid var(--line);background:var(--surface);color:var(--ink);
}
.btn-primary{background:var(--violet);border-color:var(--violet);color:#fff}
.btn-danger{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 45%,transparent)}
.hairline{border:0;border-top:1px solid var(--line);margin:2.2rem 0}
.nums{font-variant-numeric:tabular-nums}
`;

export interface ShellOpts {
  /** Plain-text page title (escaped here). */
  title: string;
  /** Page <html lang>. Defaults to 'en'. */
  lang?: string;
  /** Extra CSS appended after the shell layer. */
  css?: string;
  /** Body markup — caller escapes its own user strings. */
  body: string;
  /** Extra markup for <head> (scripts belong at the end of body instead). */
  head?: string;
}

/** Wrap body markup in a complete, self-contained HTML document. */
export function pageShell(opts: ShellOpts): string {
  const lang = escapeHtml(opts.lang ?? 'en');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<style>${THEME_CSS}${SHELL_CSS}${opts.css ?? ''}</style>
${opts.head ?? ''}</head>
<body>
${opts.body}
</body>
</html>`;
}

/** Response wrapper for shell pages. */
export function htmlResponse(html: string, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(extraHeaders ?? {}),
    },
  });
}
