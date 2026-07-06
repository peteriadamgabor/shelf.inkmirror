/**
 * GET /privacy — the Shelf's Privacy Policy, bilingual, stacked like /rules
 * and /terms. The Shelf collects almost nothing, so this is a short and
 * honest document rather than boilerplate.
 *
 * NOT legal advice. Governing law: Hungary / EU (GDPR-aware).
 */

import { htmlResponse, pageShell } from '../../html';

const PRIVACY_CSS = `
.lang-switch{display:flex;gap:1rem;font-size:.9rem;margin:0 0 2rem}
.page h2{margin-top:2rem}
.page p{margin:.6rem 0}
.eff{color:var(--muted);font-size:.85rem;letter-spacing:.06em;text-transform:uppercase}
.plist{padding-left:1.2rem}
.plist li{margin:0 0 .35rem}
`;

const EN = `<section id="en" lang="en">
<h1>Privacy</h1>
<p class="eff">Effective 7 July 2026</p>
<p class="muted">The Shelf is built to collect almost nothing. There are no accounts, no tracking,
no analytics, and no advertising. This page says plainly what we do and do not hold.</p>

<h2>What we store</h2>
<ul class="plist">
<li><strong>Published works</strong> — the prose you chose to publish, stored as plain text so anyone
with the link can read it. Notes, deleted text, revision history, and character sheets never leave
InkMirror.</li>
<li><strong>Work metadata</strong> — title, pen name, language, rating and warnings, word count, and
a one-way hash of your manage secret (never the secret itself).</li>
<li><strong>Opens</strong> — a per-work count of how many times a work was opened, visible only to
its author. It counts opens, not people, and is never used for ranking.</li>
<li><strong>Reports</strong> — the reason and any note a reporter types. Nothing about the reporter
is stored — no name, no IP, no identifier.</li>
<li><strong>Letters</strong> — a reader’s message and optional contact line, kept privately for the
author to read. We do not read them and never forward them.</li>
<li><strong>A password hash</strong>, only if you lock a work.</li>
</ul>

<h2>What we do not do</h2>
<p>No accounts, no reader profiles, no cross-site tracking, no advertising. Your IP address is used
only in the moment, to rate-limit abuse, and is not stored with your activity. The only cookie is the
one that remembers you unlocked a password-protected work, on your device.</p>

<h2>Automated moderation</h2>
<p>When — and only when — a work is submitted for listing on the public shelf, its text may be sent to
our moderation provider (Anthropic) for an automated review against the House Rules. Link-shared works
and password-locked works are private and are never sent for review.</p>

<h2>Crash reports</h2>
<p>Our server may report its own software errors to a self-hosted crash service to help us fix bugs.
These reports contain the error and the page route only — never your content, your address, or anything
that identifies a reader.</p>

<h2>Retention &amp; your control</h2>
<p>Unlisted works expire after 30 days unless renewed; you can update or unpublish at any time from your
manage link, and unpublishing deletes the copy. We keep short-lived backups of the database for disaster
recovery. To ask about or exercise your rights under the GDPR, email
<a href="mailto:privacy@inkmirror.cc">privacy@inkmirror.cc</a>.</p>

<h2>Who processes data for us</h2>
<ul class="plist">
<li><strong>Cloudflare</strong> — hosting, storage, and delivery.</li>
<li><strong>Anthropic</strong> — automated moderation, at listing time only.</li>
<li><strong>Discord</strong> — where reports and operator alerts are delivered (no reader identity).</li>
</ul>
<p class="muted small">Questions: <a href="mailto:privacy@inkmirror.cc">privacy@inkmirror.cc</a> ·
security issues: <a href="mailto:security@inkmirror.cc">security@inkmirror.cc</a>.</p>
</section>`;

const HU = `<section id="hu" lang="hu">
<h1>Adatvédelem</h1>
<p class="eff">Hatályos: 2026. július 7.</p>
<p class="muted">A Polc úgy épült, hogy szinte semmit ne gyűjtsön. Nincsenek fiókok, nincs követés,
nincs analitika, nincs hirdetés. Ez az oldal közérthetően leírja, mit tárolunk és mit nem.</p>

<h2>Mit tárolunk</h2>
<ul class="plist">
<li><strong>Publikált művek</strong> — a próza, amit publikálásra választottál, sima szövegként tárolva,
hogy bárki, akinél a link van, elolvashassa. A jegyzetek, törölt szövegek, verziótörténet és
karakterlapok sosem hagyják el az InkMirrort.</li>
<li><strong>Mű-metaadatok</strong> — cím, írói név, nyelv, korhatár-besorolás és figyelmeztetések,
szószám, valamint a kezelőkulcsod egyirányú lenyomata (soha maga a kulcs).</li>
<li><strong>Megnyitások</strong> — művenkénti szám arról, hányszor nyitották meg a művet, csak a
szerző számára látható. Megnyitásokat számol, nem embereket, és sosem használjuk rangsorolásra.</li>
<li><strong>Jelentések</strong> — az indok és a bejelentő által beírt megjegyzés. A bejelentőről semmit
nem tárolunk — sem nevet, sem IP-t, sem azonosítót.</li>
<li><strong>Levelek</strong> — az olvasó üzenete és opcionális elérhetősége, a szerző számára privátban
megőrizve. Nem olvassuk el, és sosem továbbítjuk őket.</li>
<li><strong>Jelszó-lenyomat</strong>, csak ha lezársz egy művet.</li>
</ul>

<h2>Amit nem teszünk</h2>
<p>Nincsenek fiókok, olvasói profilok, oldalak közti követés, hirdetés. Az IP-címedet csak abban a
pillanatban használjuk, a visszaélések korlátozására, és nem tároljuk a tevékenységeddel. Az egyetlen
süti az, amely megjegyzi, hogy feloldottál egy jelszóval védett művet, a saját eszközödön.</p>

<h2>Automatikus moderálás</h2>
<p>Amikor — és csak akkor — egy művet a nyilvános polcra listázásra beküldenek, a szövege elküldhető a
moderálási szolgáltatónknak (Anthropic) a Házirend szerinti automatikus átvizsgálásra. A linken megosztott
és a jelszóval zárolt művek priváták, és sosem küldjük el őket átvizsgálásra.</p>

<h2>Hibajelentések</h2>
<p>A szerverünk jelentheti a saját szoftverhibáit egy saját üzemeltetésű hibaszolgáltatásnak, hogy
javíthassuk a hibákat. Ezek a jelentések csak a hibát és az oldal útvonalát tartalmazzák — sosem a
tartalmadat, a címedet vagy bármit, ami egy olvasót azonosít.</p>

<h2>Megőrzés és a te irányításod</h2>
<p>A listázatlan művek 30 nap után lejárnak, hacsak meg nem hosszabbítod; bármikor frissítheted vagy
visszavonhatod a művet a kezelőlinkedről, és a visszavonás törli a másolatot. Az adatbázisról rövid
életű biztonsági mentéseket tartunk katasztrófa-helyreállításhoz. A GDPR szerinti jogaid gyakorlásához
vagy kérdésekhez írj ide: <a href="mailto:privacy@inkmirror.cc">privacy@inkmirror.cc</a>.</p>

<h2>Ki dolgozza fel az adatokat nekünk</h2>
<ul class="plist">
<li><strong>Cloudflare</strong> — tárhely, tárolás és kézbesítés.</li>
<li><strong>Anthropic</strong> — automatikus moderálás, csak listázáskor.</li>
<li><strong>Discord</strong> — ide érkeznek a jelentések és az üzemeltetői riasztások (olvasói azonosító nélkül).</li>
</ul>
<p class="muted small">Kérdések: <a href="mailto:privacy@inkmirror.cc">privacy@inkmirror.cc</a> ·
biztonsági bejelentés: <a href="mailto:security@inkmirror.cc">security@inkmirror.cc</a>.</p>
</section>`;

export function privacyPage(): Response {
  return htmlResponse(
    pageShell({
      title: 'Privacy — The Shelf',
      css: PRIVACY_CSS,
      body: `<div class="page">
<nav class="lang-switch" aria-label="Language"><a href="#en">English</a><a href="#hu">Magyar</a></nav>
${EN}
<hr class="hairline">
${HU}
<hr class="hairline">
<p class="muted small"><a href="/">The Shelf</a> · <a href="/rules">House rules</a> · <a href="/terms">Terms</a></p>
</div>`,
    }),
  );
}
