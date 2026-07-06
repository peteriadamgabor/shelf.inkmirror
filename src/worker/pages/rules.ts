/**
 * GET /rules — the house rules, bilingual (EN first, HU below, anchor-linked).
 * This page exists before the first explicit work does: policy is part of the
 * product, not an afterthought. Register: clear and calm, no legalese walls.
 */

import { htmlResponse, pageShell } from '../../html';

const RULES_CSS = `
.lang-switch{display:flex;gap:1rem;font-size:.9rem;margin:0 0 2rem}
.rule-list{padding-left:1.2rem}
.rule-list li{margin:0 0 .5rem}
dt{font-weight:600;margin:1rem 0 .15rem}
dd{margin:0 0 .6rem 0;color:var(--muted)}
`;

const EN = `<section id="en" lang="en">
<h1>House rules</h1>
<p class="muted">The Shelf hosts fiction published from InkMirror and shared by link.
There are no accounts and no feeds — just works, labels, and readers. These rules keep
that possible.</p>

<h2>Ratings</h2>
<dl>
<dt>General</dt>
<dd>Readable by anyone. No explicit sex, no graphic violence.</dd>
<dt>Mature</dt>
<dd>16+. Adult themes handled non-explicitly — violence, sexuality, heavy subject matter present but not graphic.</dd>
<dt>Explicit</dt>
<dd>18+ only, behind an age gate. Explicit sex and/or graphic violence.</dd>
</dl>

<h2>Warning tags</h2>
<p>Authors check every tag that applies, from a fixed vocabulary:</p>
<ul class="rule-list">
<li>Graphic violence</li>
<li>Sexual content</li>
<li>Sexual violence</li>
<li>Self-harm / suicide</li>
<li>Child abuse (non-sexual depiction)</li>
<li>Substance abuse</li>
<li>Other (free text)</li>
</ul>
<p>Tags are shown before any prose, always. Readers choose informed; that is the whole system.</p>

<h2>What gets a work removed</h2>
<p>The Shelf polices <strong>labels and legality — never themes</strong>. Dark fiction,
honestly labeled, belongs here. Two things do not:</p>
<h3>Hard lines — removal, no appeal</h3>
<ul class="rule-list">
<li>Sexual content involving minors.</li>
<li>Doxxing or harassment of real persons.</li>
<li>Plagiarism, on credible claim.</li>
<li>Content illegal under our host&#39;s acceptable-use policy.</li>
</ul>
<h3>Mislabeling</h3>
<p>The one bannable offense for everything else. It is judged as a yes/no —
<em>does the work contain what its rating and tags say?</em> — never as literary merit.
A mislabeled work is taken down; the author may republish it labeled honestly.</p>

<h2>Reports</h2>
<p>Every work carries a &ldquo;Report this work&rdquo; form. Reports go to a human — not an
algorithm — who checks the claim against these rules. Hard-line violations are removed;
mislabeling is removed and may be republished with honest labels; everything else stays up.
Disliking a story is not a violation.</p>

<h2>The public shelf</h2>
<p>Link-shared works are unlisted and appear nowhere public. Putting a work on
<a href="/shelf">the Shelf</a> is a separate, explicit choice by its author — and it is
the moment of moderation: every listing request is reviewed against these rules
(labels and hard lines, never themes) before the work appears. A refused listing stays
readable by its link; the author sees why and can fix the labels and try again.
The shelf shows works by listing date only — no view counts, no rankings, ever.</p>

<h2>Password-locked works</h2>
<p>A work can be locked with a password the author shares privately — for beta readers
or a writing circle. A locked work is treated as private: it is <strong>never sent to
any moderation service</strong>, and it cannot be listed on the public shelf. Private and
public are mutually exclusive by design.</p>

<h2>Expiry</h2>
<p>Unlisted links live for <strong>30 days</strong>. The author can renew from the manage
link, any number of times, or unpublish at any moment. Nothing lingers by accident.
Works listed on the shelf are exempt from expiry while they stay listed.</p>
</section>`;

const HU = `<section id="hu" lang="hu">
<h1>Házirend</h1>
<p class="muted">A Shelf az InkMirrorból közzétett, linkkel megosztott szépirodalmi
műveknek ad otthont. Nincsenek fiókok, nincsenek hírfolyamok — csak művek, címkék és
olvasók. Ez a házirend tartja ezt fenn.</p>

<h2>Korhatár-besorolások</h2>
<dl>
<dt>Általános (General)</dt>
<dd>Bárki olvashatja. Nincs explicit szexualitás, nincs naturalista erőszak.</dd>
<dt>Felnőtt (Mature)</dt>
<dd>16+. Felnőtt témák, nem explicit módon — erőszak, szexualitás, nehéz témák jelen vannak, de nem részletezve.</dd>
<dt>Explicit</dt>
<dd>Csak 18+, korhatár-kapu mögött. Explicit szexualitás és/vagy naturalista erőszak.</dd>
</dl>

<h2>Figyelmeztető címkék</h2>
<p>A szerző minden ráillő címkét bejelöl egy rögzített szótárból:</p>
<ul class="rule-list">
<li>Naturalista erőszak</li>
<li>Szexuális tartalom</li>
<li>Szexuális erőszak</li>
<li>Önsértés / öngyilkosság</li>
<li>Gyermekbántalmazás (nem szexuális ábrázolás)</li>
<li>Szerhasználat</li>
<li>Egyéb (szabad szöveg)</li>
</ul>
<p>A címkék minden esetben a próza előtt jelennek meg. Az olvasó tájékozottan dönt — ez a rendszer lényege.</p>

<h2>Miért kerül le egy mű</h2>
<p>A Shelf a <strong>címkéket és a törvényességet felügyeli — sosem a témákat</strong>.
A sötét, de őszintén címkézett irodalomnak itt a helye. Két dolognak nincs:</p>
<h3>Vörös vonalak — eltávolítás, fellebbezés nélkül</h3>
<ul class="rule-list">
<li>Kiskorúakat érintő szexuális tartalom.</li>
<li>Valós személyek adatainak kiszivárogtatása vagy zaklatása.</li>
<li>Plágium, hitelt érdemlő bejelentés alapján.</li>
<li>A tárhelyszolgáltató szabályzata szerint illegális tartalom.</li>
</ul>
<h3>Félrecímkézés</h3>
<p>Minden másra ez az egyetlen kitiltással járó vétség. Eldöntendő kérdésként bíráljuk el —
<em>azt tartalmazza-e a mű, amit a besorolása és a címkéi állítanak?</em> — sosem irodalmi
érték alapján. A félrecímkézett mű lekerül; a szerző őszinte címkékkel újra közzéteheti.</p>

<h2>Bejelentések</h2>
<p>Minden műnél ott a „Mű bejelentése” űrlap. A bejelentést ember bírálja el — nem algoritmus —,
a fenti szabályok mentén. A vörös vonalat átlépő mű lekerül; a félrecímkézett mű lekerül és
őszinte címkékkel visszatérhet; minden más fennmarad. Az, hogy egy történet nem tetszik,
nem szabálysértés.</p>

<h2>A nyilvános polc</h2>
<p>A linkkel megosztott művek nem listázottak, és sehol sem jelennek meg nyilvánosan.
Egy mű <a href="/shelf">polcra tétele</a> a szerző külön, kifejezett döntése — és ez a
moderáció pillanata: minden listázási kérést e szabályok mentén vizsgálunk meg (címkék
és vörös vonalak, sosem témák), mielőtt a mű megjelenne. Az elutasított listázás linkről
továbbra is olvasható; a szerző látja az okot, javíthatja a címkéket, és újra próbálkozhat.
A polc kizárólag a listázás ideje szerint rendez — megtekintésszám és rangsor nincs, soha.</p>

<h2>Lejárat</h2>
<p>A nem listázott linkek <strong>30 napig</strong> élnek. A szerző a kezelőlinkről bármennyiszer
meghosszabbíthatja, vagy bármikor visszavonhatja a művet. Semmi sem marad fenn véletlenül.
A polcra listázott művek a listázás ideje alatt mentesülnek a lejárat alól.</p>
</section>`;

export function rulesPage(): Response {
  return htmlResponse(
    pageShell({
      title: 'House rules — The Shelf',
      css: RULES_CSS,
      body: `<div class="page">
<nav class="lang-switch" aria-label="Language"><a href="#en">English</a><a href="#hu">Magyar</a></nav>
${EN}
<hr class="hairline">
${HU}
<hr class="hairline">
<p class="muted small"><a href="/">The Shelf</a> · <a href="https://inkmirror.cc" rel="noopener">InkMirror</a></p>
</div>`,
    }),
  );
}
