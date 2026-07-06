/**
 * GET /terms — the Shelf's Terms of Service, bilingual (EN first, HU below),
 * matching the rules page's stacked layout. Legal docs are shown in both
 * languages so any reader — or authority — can read either.
 *
 * NOT legal advice and not lawyer-drafted: adapted template content for a
 * small, non-commercial service. Governing law: Hungary / EU.
 */

import { htmlResponse, pageShell } from '../../html';

const TERMS_CSS = `
.lang-switch{display:flex;gap:1rem;font-size:.9rem;margin:0 0 2rem}
.page h2{margin-top:2rem}
.page p{margin:.6rem 0}
.eff{color:var(--muted);font-size:.85rem;letter-spacing:.06em;text-transform:uppercase}
`;

const EN = `<section id="en" lang="en">
<h1>Terms of Service</h1>
<p class="eff">Effective 7 July 2026</p>
<p class="muted">The Shelf (shelf.inkmirror.cc) hosts fiction that writers publish from InkMirror
and share by link. There are no accounts. By publishing to, or reading on, the Shelf you agree to
these terms. They are short and plain; where they are silent, good faith applies.</p>

<h2>For writers who publish</h2>
<p>You keep full copyright in everything you publish — we claim no ownership. By publishing, you
grant us only the limited licence needed to host, display, cache, and moderate the copy you chose
to make public, for as long as it is published. You can withdraw that at any time by unpublishing
from your manage link.</p>
<p>You are responsible for what you publish. You confirm you have the right to publish it, that it
does not infringe anyone else’s rights, and that it follows the <a href="/rules">House Rules</a> —
including honest ratings and content warnings, and the hard lines listed there. The manage link is
the only key to your published work; keep it safe. We cannot recover it, and anyone who holds it can
change or remove the work.</p>

<h2>For readers</h2>
<p>Works may carry adult ratings; confirming you are old enough where an age gate appears is your
responsibility. Do not abuse the reporting or letter forms, attempt to break the service’s security,
or scrape it at scale.</p>

<h2>Moderation and removal</h2>
<p>Link-shared works are unmoderated plumbing; listing a work on the public shelf is a separate
choice and the point at which it is reviewed. We may hold, refuse, unlist, or remove any work — with
or without notice — where it breaks the House Rules or the law, and we always remove content that
crosses a hard line. Removal is a safety measure, not a judgement of literary merit.</p>

<h2>Copyright &amp; takedown</h2>
<p>If a work infringes your copyright, or you believe your work was plagiarised, email
<a href="mailto:abuse@inkmirror.cc">abuse@inkmirror.cc</a> with the work link, what is infringed, and
enough detail to act. We remove credibly infringing content promptly and may tombstone it so the same
text cannot be republished.</p>

<h2>Availability, no warranty</h2>
<p>The Shelf is a free service provided “as is”, with no warranty of any kind and no guarantee of
availability. Unlisted works expire after 30 days unless renewed. We may change or end the service.
Keep your own copy of anything you value — your manuscript always lives, in full, in InkMirror.</p>

<h2>Limitation of liability</h2>
<p>To the fullest extent the law allows, we are not liable for any indirect, incidental, or
consequential loss arising from the Shelf — including lost content, lost access, or a lost manage
link. Nothing here limits liability that cannot be limited by law.</p>

<h2>Changes &amp; governing law</h2>
<p>We may update these terms; the date above changes when we do. They are governed by the laws of
Hungary and the European Union, and do not affect your statutory rights. Questions:
<a href="mailto:legal@inkmirror.cc">legal@inkmirror.cc</a>.</p>
</section>`;

const HU = `<section id="hu" lang="hu">
<h1>Felhasználási feltételek</h1>
<p class="eff">Hatályos: 2026. július 7.</p>
<p class="muted">A Polc (shelf.inkmirror.cc) olyan szépirodalmat tárol, amelyet szerzők az
InkMirrorból publikálnak és linken osztanak meg. Nincsenek fiókok. Ha a Polcra publikálsz vagy ott
olvasol, elfogadod ezeket a feltételeket. Rövidek és közérthetők; ahol hallgatnak, ott a jóhiszeműség
a mérce.</p>

<h2>Publikáló szerzőknek</h2>
<p>Minden szerzői jogod megmarad azon, amit publikálsz — mi nem igénylünk tulajdont. A publikálással
csak azt a korlátozott engedélyt adod meg, amely a nyilvánossá tett másolat tárolásához,
megjelenítéséhez, gyorsítótárazásához és moderálásához szükséges, ameddig publikálva van. Ezt bármikor
visszavonhatod a mű visszavonásával a kezelőlinkedről.</p>
<p>Te felelsz azért, amit publikálsz. Megerősíted, hogy jogod van publikálni, hogy nem sérti mások
jogait, és hogy megfelel a <a href="/rules">Házirendnek</a> — beleértve az őszinte korhatár-besorolást
és tartalmi figyelmeztetéseket, valamint az ott felsorolt kemény határokat. A kezelőlink az egyetlen
kulcs a publikált művedhez; őrizd meg. Nem tudjuk helyreállítani, és aki birtokolja, módosíthatja vagy
eltávolíthatja a művet.</p>

<h2>Olvasóknak</h2>
<p>A művek felnőtt besorolást viselhetnek; ahol korhatár-kapu jelenik meg, a te felelősséged
megerősíteni, hogy elég idős vagy. Ne élj vissza a jelentő vagy levél űrlapokkal, ne próbáld megkerülni
a szolgáltatás biztonságát, és ne aratózd le nagy tételben.</p>

<h2>Moderálás és eltávolítás</h2>
<p>A linken megosztott művek moderálatlan „vízvezetékek”; egy mű nyilvános polcra tétele külön döntés,
és ez az a pont, ahol átvizsgálják. Bármely művet visszatarthatunk, elutasíthatunk, levehetünk a polcról
vagy eltávolíthatunk — értesítéssel vagy anélkül —, ha megsérti a Házirendet vagy a törvényt, és mindig
eltávolítjuk a kemény határt átlépő tartalmat. Az eltávolítás biztonsági intézkedés, nem az irodalmi
érték megítélése.</p>

<h2>Szerzői jog és eltávolítási kérelem</h2>
<p>Ha egy mű sérti a szerzői jogodat, vagy úgy véled, a művedet plagizálták, írj ide:
<a href="mailto:abuse@inkmirror.cc">abuse@inkmirror.cc</a> — add meg a mű linkjét, mi sérül, és elég
részletet ahhoz, hogy eljárjunk. A hitelt érdemlően jogsértő tartalmat haladéktalanul eltávolítjuk, és
akár „sírkővel” is megjelölhetjük, hogy ugyanaz a szöveg ne legyen újra publikálható.</p>

<h2>Elérhetőség, garancia kizárása</h2>
<p>A Polc ingyenes szolgáltatás, „ahogy van” alapon, mindenféle garancia és rendelkezésre állási
ígéret nélkül. A listázatlan művek 30 nap után lejárnak, hacsak meg nem hosszabbítod. A szolgáltatást
módosíthatjuk vagy megszüntethetjük. Tarts saját másolatot mindenről, ami fontos — a kéziratod teljes
egészében mindig az InkMirrorban él.</p>

<h2>Felelősség korlátozása</h2>
<p>A jog által megengedett legteljesebb mértékben nem vállalunk felelősséget a Polcból eredő közvetett,
járulékos vagy következményi károkért — beleértve az elveszett tartalmat, hozzáférést vagy kezelőlinket.
Az itt leírtak nem korlátozzák azt a felelősséget, amely jogszabály szerint nem korlátozható.</p>

<h2>Változások és irányadó jog</h2>
<p>Frissíthetjük ezeket a feltételeket; ilyenkor a fenti dátum változik. Rájuk Magyarország és az
Európai Unió joga az irányadó, és nem érintik a törvényes jogaidat. Kérdések:
<a href="mailto:legal@inkmirror.cc">legal@inkmirror.cc</a>.</p>
</section>`;

export function termsPage(): Response {
  return htmlResponse(
    pageShell({
      title: 'Terms of Service — The Shelf',
      css: TERMS_CSS,
      body: `<div class="page">
<nav class="lang-switch" aria-label="Language"><a href="#en">English</a><a href="#hu">Magyar</a></nav>
${EN}
<hr class="hairline">
${HU}
<hr class="hairline">
<p class="muted small"><a href="/">The Shelf</a> · <a href="/rules">House rules</a> · <a href="/privacy">Privacy</a></p>
</div>`,
    }),
  );
}
