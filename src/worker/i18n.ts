/**
 * Tiny Worker-side i18n. No framework: a dictionary per locale and a `t()`
 * that walks dot-keys. Two locales — English and Magyar — matching the two
 * languages InkMirror itself ships.
 *
 * Which locale a page speaks:
 *   - a BAKED reading page + its work-specific live pages (gate, report,
 *     letter, manage) follow the WORK's language (a Hungarian novel gets
 *     Hungarian chrome) — see langForWork();
 *   - the GLOBAL pages (landing, /shelf, not-found) follow the request —
 *     ?lang= override, then Accept-Language, then English — see langForRequest().
 *
 * Anything outside {en, hu} falls back to English.
 */

export const SUPPORTED_LANGS = ['en', 'hu'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

function isLang(x: string): x is Lang {
  return (SUPPORTED_LANGS as readonly string[]).includes(x);
}

/** A work's declared language → chrome locale (en for anything non-hu). */
export function langForWork(workLanguage: string): Lang {
  const base = workLanguage.toLowerCase().split('-')[0] ?? '';
  return isLang(base) ? base : 'en';
}

/** Request → chrome locale: ?lang= wins, then Accept-Language, then en. */
export function langForRequest(request: Request, url: URL): Lang {
  const q = url.searchParams.get('lang');
  if (q !== null && isLang(q)) return q;
  const header = request.headers.get('accept-language') ?? '';
  for (const part of header.split(',')) {
    const base = part.trim().toLowerCase().split(';')[0]?.split('-')[0] ?? '';
    if (isLang(base)) return base;
  }
  return 'en';
}

type Dict = Record<string, unknown>;

const en: Dict = {
  brand: 'The Shelf',
  by: 'by',
  backToWork: 'Back to the work',
  houseRules: 'House rules',
  rating: { general: 'General', mature: 'Mature', explicit: 'Explicit' },
  warning: {
    'graphic-violence': 'Graphic violence',
    'sexual-content': 'Sexual content',
    'sexual-violence': 'Sexual violence',
    'self-harm': 'Self-harm / suicide',
    'child-abuse-depiction': 'Child abuse (depiction)',
    'substance-abuse': 'Substance abuse',
    other: 'Other',
  },
  read: {
    gate: {
      ratedLine: 'This work is rated',
      adultLine: 'and is intended for adult readers.',
      enter: 'I&#39;m 18 or older — read',
      back: 'Take me back',
      noscript: 'This work is rated for adults. Enable JavaScript to confirm your age and read it.',
    },
    nav: { cover: 'Cover', previous: 'Previous', next: 'Next', contents: 'Contents' },
    toc: { heading: 'Contents', continue: 'Continue reading', continueTo: 'Continue —' },
    chapterN: 'Chapter', // "Chapter 3" when a chapter hides its title
    foot: { letter: 'Write to the author', report: 'Report this work', mark: 'Written with InkMirror', words: 'words' },
  },
  gate: {
    locked: 'This work is locked',
    hint: 'The author shares the password personally.',
    unlock: 'Unlock',
    wrong: 'That&#39;s not it.',
    tooMany: 'Too many tries — wait a minute.',
    placeholder: 'Password',
  },
  report: {
    tab: 'Report',
    title: 'Report this work',
    rulesLink: 'Shelf rules',
    formIntro:
      'Reports are reviewed against the {rules} by a human. Mislabeling and hard-line violations are acted on; disliking a story is not a violation.',
    confirmIntro:
      'Reports are reviewed against the {rules}. Mislabeling and hard-line violations are acted on; disliking a story is not a violation.',
    reasonLabel: 'Reason',
    reasonMislabeled: 'Mislabeled (rating or warnings are dishonest)',
    reasonHardLine: 'Hard-line content (minors / doxxing / illegal)',
    reasonPlagiarism: 'Plagiarism',
    reasonOther: 'Other',
    detailsLabel: 'Details (optional)',
    submit: 'Send report',
    receivedTab: 'Report received',
    thankYou: 'Thank you',
    received: 'Your report has been received — a human will look at this.',
  },
  letter: {
    intro:
      'Your letter goes privately to the writer — one way, no threads, nothing public. They only see what you type below.',
    bodyLabel: 'Your letter',
    contactLabel: 'Where to answer (optional)',
    contactPlaceholder: 'only if you&#39;d like an answer',
    submit: 'Send letter',
    hardLineLink: 'hard line',
    hardLine: 'Letters that cross a {link} can still be reported by their recipient.',
    sentTab: 'Letter sent',
    sent: 'Sent',
    sentBody: 'Your letter is on its way to the author.',
    sentNote: 'Letters go privately to the writer — one way, no threads, nothing public.',
  },
  landing: {
    docTitle: 'The Shelf — the reading room next door to InkMirror',
    tagline: 'The reading room next door to {ink}.',
    sub:
      'Writers publish a draft or a finished work by explicit choice and share it by unlisted link — no accounts, no feeds, no algorithm. Works are labeled honestly, read quietly, and expire after 30 days unless their author renews them. Listing on the public shelf is a second explicit choice, and the one moment a work is moderated.',
    ctaWrite: 'Write with InkMirror',
    ctaSample: 'Read a sample — Rothschild&#39;s Fiddle',
    ctaBrowse: 'Browse the Shelf',
    fine: 'No accounts. No tracking. {rules} apply to every shared work.',
  },
  shelf: {
    docTitle: 'The Shelf — works published from InkMirror',
    description:
      'Browse works their writers chose to publish from the InkMirror editor — honest labels, quiet reading, no accounts, no feeds, no rankings.',
    tagline: 'Works published from the InkMirror editor. Every writer chose to put these here.',
    workOne: 'work',
    workMany: 'works',
    filterAll: 'All',
    filtersLabel: 'Filters',
    language: 'Language',
    warnOne: 'warning',
    warnMany: 'warnings',
    empty: 'Nothing on this shelf yet &mdash; the books are still being written.',
    newer: 'Newer',
    older: 'Older',
    pages: 'Pages',
    footNote:
      'Every listed work passed a moderation review at listing time &mdash; labels and legality, never themes.',
  },
  notFound: {
    tab: 'Not found',
    heading: 'Nothing on this shelf',
    body:
      'This work doesn&#39;t exist, was unpublished by its author, or its link expired. Unlisted links live for 30 days unless the author renews them.',
  },
};

const hu: Dict = {
  brand: 'A Polc',
  by: 'írta',
  backToWork: 'Vissza a műhöz',
  houseRules: 'Házirend',
  rating: { general: 'Általános', mature: 'Felnőtt', explicit: 'Explicit' },
  warning: {
    'graphic-violence': 'Grafikus erőszak',
    'sexual-content': 'Szexuális tartalom',
    'sexual-violence': 'Szexuális erőszak',
    'self-harm': 'Önbántalmazás / öngyilkosság',
    'child-abuse-depiction': 'Gyermekbántalmazás (ábrázolás)',
    'substance-abuse': 'Szerhasználat',
    other: 'Egyéb',
  },
  read: {
    gate: {
      ratedLine: 'Ez a mű besorolása',
      adultLine: '— felnőtt olvasóknak szól.',
      enter: 'Elmúltam 18 — olvasom',
      back: 'Vissza',
      noscript: 'Ez a mű felnőtteknek szól. Engedélyezd a JavaScriptet a korod megerősítéséhez.',
    },
    nav: { cover: 'Borító', previous: 'Előző', next: 'Következő', contents: 'Tartalom' },
    toc: { heading: 'Tartalom', continue: 'Folytatás', continueTo: 'Folytatás —' },
    chapterN: 'fejezet', // Hungarian: "3. fejezet" — number precedes, handled at the call site
    foot: { letter: 'Írj a szerzőnek', report: 'Mű jelentése', mark: 'InkMirrorral írva', words: 'szó' },
  },
  gate: {
    locked: 'Ez a mű zárolva van',
    hint: 'A jelszót a szerző személyesen osztja meg.',
    unlock: 'Feloldás',
    wrong: 'Nem ez az.',
    tooMany: 'Túl sok próbálkozás — várj egy percet.',
    placeholder: 'Jelszó',
  },
  report: {
    tab: 'Jelentés',
    title: 'Mű jelentése',
    rulesLink: 'A Polc szabályai',
    formIntro:
      'A jelentéseket ember vizsgálja meg a {rules} alapján. A félrecímkézést és a kemény határok átlépését kezeljük; egy történet nem tetszése nem szabálysértés.',
    confirmIntro:
      'A jelentéseket a {rules} alapján vizsgáljuk. A félrecímkézést és a kemény határok átlépését kezeljük; egy történet nem tetszése nem szabálysértés.',
    reasonLabel: 'Ok',
    reasonMislabeled: 'Félrecímkézve (a besorolás vagy a figyelmeztetések megtévesztők)',
    reasonHardLine: 'Kemény határt sértő tartalom (kiskorúak / doxolás / illegális)',
    reasonPlagiarism: 'Plágium',
    reasonOther: 'Egyéb',
    detailsLabel: 'Részletek (nem kötelező)',
    submit: 'Jelentés küldése',
    receivedTab: 'Jelentés megérkezett',
    thankYou: 'Köszönjük',
    received: 'A jelentésed megérkezett — egy ember megnézi.',
  },
  letter: {
    intro:
      'A leveled közvetlenül a szerzőhöz jut — egyirányú, nincs szál, semmi nyilvános. Csak azt látja, amit ide beírsz.',
    bodyLabel: 'A leveled',
    contactLabel: 'Hová válaszoljunk (nem kötelező)',
    contactPlaceholder: 'csak ha szeretnél választ',
    submit: 'Levél küldése',
    hardLineLink: 'kemény határt',
    hardLine: 'A {link} átlépő leveleket a címzett továbbra is jelentheti.',
    sentTab: 'Levél elküldve',
    sent: 'Elküldve',
    sentBody: 'A leveled úton van a szerzőhöz.',
    sentNote: 'A levelek közvetlenül a szerzőhöz jutnak — egyirányú, nincs szál, semmi nyilvános.',
  },
  landing: {
    docTitle: 'A Polc — az olvasószoba az InkMirror szomszédjában',
    tagline: 'Az olvasószoba az {ink} szomszédjában.',
    sub:
      'A szerzők kifejezett döntéssel tesznek közzé egy vázlatot vagy kész művet, és nem listázott linken osztják meg — fiókok, hírfolyamok és algoritmusok nélkül. A műveket őszintén címkézik, csendben olvassák, és 30 nap után lejárnak, hacsak a szerzőjük meg nem újítja őket. A nyilvános polcra kerülés egy második kifejezett döntés — és az egyetlen pillanat, amikor egy művet moderálnak.',
    ctaWrite: 'Írj az InkMirrorral',
    ctaSample: 'Olvass bele — Rothschild hegedűje',
    ctaBrowse: 'Böngészd a Polcot',
    fine: 'Nincsenek fiókok. Nincs nyomkövetés. A {rules} minden megosztott műre vonatkozik.',
  },
  shelf: {
    docTitle: 'A Polc — az InkMirrorból közzétett művek',
    description:
      'Böngéssz olyan művek között, amelyeket szerzőik döntöttek úgy, hogy közzétesznek az InkMirror szerkesztőből — őszinte címkék, csendes olvasás, fiókok, hírfolyamok és rangsorok nélkül.',
    tagline: 'Az InkMirror szerkesztőből közzétett művek. Minden szerző maga döntött úgy, hogy ide teszi őket.',
    workOne: 'mű',
    workMany: 'mű',
    filterAll: 'Mind',
    filtersLabel: 'Szűrők',
    language: 'Nyelv',
    warnOne: 'figyelmeztetés',
    warnMany: 'figyelmeztetés',
    empty: 'Ezen a polcon még nincs semmi &mdash; a könyvek még íródnak.',
    newer: 'Újabb',
    older: 'Régebbi',
    pages: 'Oldalak',
    footNote:
      'Minden listázott mű átment egy moderációs ellenőrzésen a listázáskor &mdash; címkék és jogszerűség, sosem témák.',
  },
  notFound: {
    tab: 'Nem található',
    heading: 'Semmi sincs ezen a polcon',
    body:
      'Ez a mű nem létezik, a szerzője visszavonta, vagy lejárt a linkje. A nem listázott linkek 30 napig élnek, hacsak a szerző meg nem újítja őket.',
  },
};

const DICTS: Record<Lang, Dict> = { en, hu };

/** Look up a dot-path key in the locale, falling back to English then the key. */
export function t(lang: Lang, key: string): string {
  const walk = (dict: Dict): unknown =>
    key.split('.').reduce<unknown>((acc, part) => {
      if (typeof acc === 'object' && acc !== null) return (acc as Dict)[part];
      return undefined;
    }, dict);
  const hit = walk(DICTS[lang]);
  if (typeof hit === 'string') return hit;
  const fallback = walk(en);
  return typeof fallback === 'string' ? fallback : key;
}
