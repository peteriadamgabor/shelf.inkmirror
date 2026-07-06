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
    placeholder: 'Password',
  },
};

const hu: Dict = {
  brand: 'A Polc',
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
    placeholder: 'Jelszó',
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
