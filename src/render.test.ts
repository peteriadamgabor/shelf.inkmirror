import { describe, expect, it } from 'vitest';
import { PUBLISH_BUNDLE_KIND, PUBLISH_BUNDLE_VERSION, type PublishBundleV1, type PublishedBlock, type PublishedChapter } from './format';
import { countWords, firstLine, renderMarkedContent, renderWorkPages } from './render';

/** Single-page view: the index page (single-chapter bundles bake only this). */
function renderWorkPage(b: PublishBundleV1, meta: { id: string }): string {
  return renderWorkPages(b, meta).index;
}

function bundle(overrides: Partial<PublishBundleV1> = {}): PublishBundleV1 {
  return {
    kind: PUBLISH_BUNDLE_KIND,
    version: PUBLISH_BUNDLE_VERSION,
    app_version: '0.11.3',
    title: 'A Quiet Book',
    pen_name: 'Á. Péteri',
    language: 'en',
    rating: 'general',
    warnings: [],
    document: { synopsis: '', pov_character_id: null },
    chapters: [{ id: 'ch1', title: 'One', order: 0, kind: 'standard' }],
    blocks: [
      {
        id: 'b1',
        chapter_id: 'ch1',
        type: 'text',
        content: 'Two hearts, one soul.',
        order: 0,
        metadata: { type: 'text' },
      },
    ],
    characters: [],
    ...overrides,
  };
}

const META = { id: 'AAAAAAAAAAAAAAAAAAAAAA' };

describe('renderMarkedContent', () => {
  it('slices marks correctly on content containing HTML-escapable chars', () => {
    // "a<b & c" with bold 0–3: offsets address the RAW string; escaping
    // first would shift them past the '<'.
    expect(renderMarkedContent('a<b & c', [{ type: 'bold', start: 0, end: 3 }])).toBe(
      '<strong>a&lt;b</strong> &amp; c',
    );
  });

  it('handles overlapping bold and italic', () => {
    expect(
      renderMarkedContent('abcd', [
        { type: 'bold', start: 0, end: 3 },
        { type: 'italic', start: 2, end: 4 },
      ]),
    ).toBe('<strong>ab</strong><strong><em>c</em></strong><em>d</em>');
  });

  it('escapes plain content without marks', () => {
    expect(renderMarkedContent('x < y & "z"', undefined)).toBe('x &lt; y &amp; &quot;z&quot;');
  });
});

describe('renderWorkPage — escaping', () => {
  it('escapes HTML in title, content, and character name', () => {
    const html = renderWorkPage(
      bundle({
        title: '<script>alert(1)</script>',
        pen_name: '"><img src=x onerror=alert(2)>',
        characters: [{ id: 'c1', name: '<b>Evil</b>', color: '#ff0000' }],
        blocks: [
          {
            id: 'b1',
            chapter_id: 'ch1',
            type: 'dialogue',
            content: 'hello & <goodbye>',
            order: 0,
            metadata: { type: 'dialogue', data: { speaker_id: 'c1' } },
          },
        ],
      }),
      META,
    );
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    // Character names never render on the reading page (novel-first dialogue).
    expect(html).not.toContain('Evil');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('hello &amp; &lt;goodbye&gt;');
  });

  it('escapes scene location and time', () => {
    const html = renderWorkPage(
      bundle({
        blocks: [
          {
            id: 'b1',
            chapter_id: 'ch1',
            type: 'scene',
            content: 'The rain kept falling.',
            order: 0,
            metadata: {
              type: 'scene',
              data: { location: '<u>Pest</u>', time: 'dawn & dusk', character_ids: [], mood: '' },
            },
          },
        ],
      }),
      META,
    );
    expect(html).not.toContain('<u>Pest</u>');
    expect(html).toContain('&lt;u&gt;Pest&lt;/u&gt; · dawn &amp; dusk');
  });
});

describe('renderWorkPage — age gate', () => {
  it('explicit works get the gate and hidden prose', () => {
    const html = renderWorkPage(bundle({ rating: 'explicit', warnings: ['sexual-content'] }), META);
    expect(html).toContain('id="age-gate"');
    expect(html).toContain('<main id="work" hidden>');
    expect(html).toContain('shelf.age.ok');
    expect(html).toContain('<noscript>');
    expect(html).toContain('Sexual content');
  });

  it('mature works are gated too', () => {
    const html = renderWorkPage(bundle({ rating: 'mature' }), META);
    expect(html).toContain('id="age-gate"');
  });

  it('general works render without any gate', () => {
    const html = renderWorkPage(bundle(), META);
    expect(html).not.toContain('age-gate');
    expect(html).toContain('<main id="work">');
  });
});

describe('renderWorkPage — dialogue', () => {
  const chars = [
    { id: 'me', name: 'Ilka', color: '#7F77DD' },
    { id: 'them', name: 'Bora', color: '#0d9488' },
  ];
  function dlg(id: string, speaker: string, order: number): PublishedBlock {
    return {
      id,
      chapter_id: 'ch1',
      type: 'dialogue',
      content: `line ${id}`,
      order,
      metadata: { type: 'dialogue', data: { speaker_id: speaker } },
    };
  }

  it('dialogue renders as prose with a color accent — no pills, bubbles, or POV alignment', () => {
    const html = renderWorkPage(
      bundle({
        characters: chars,
        document: { synopsis: '', pov_character_id: 'me' },
        blocks: [dlg('b1', 'me', 0), dlg('b2', 'them', 1)],
      }),
      META,
    );
    const blockAround = (marker: string): string => {
      const end = html.indexOf(marker);
      const start = html.lastIndexOf('<div class="dlg"', end);
      return html.slice(start, end);
    };
    expect(blockAround('line b1')).toContain('--accent:var(--violet)');
    expect(blockAround('line b2')).toContain('--accent:#0d9488');
    // Editor furniture must not reach readers.
    expect(html).not.toContain('dlg-pov');
    expect(html).not.toContain('class="pill"');
    expect(html).not.toContain('class="bubble"');
    expect(html).not.toContain('Ilka');
    expect(html).not.toContain('Bora');
  });

  it('invalid character color falls back to teal', () => {
    const html = renderWorkPage(
      bundle({
        characters: [{ id: 'c1', name: 'X', color: 'red;} body{background:url(evil)' }],
        blocks: [dlg('b1', 'c1', 0)],
      }),
      META,
    );
    expect(html).toContain('style="--accent:var(--teal)"');
    expect(html).not.toContain('url(evil)');
  });

  it('unassigned speaker gets the neutral hairline accent', () => {
    const html = renderWorkPage(bundle({ blocks: [dlg('b1', '', 0)] }), META);
    expect(html).toContain('style="--accent:var(--line)"');
    expect(html).not.toContain('class="pill"');
  });

  it('parenthetical renders as its own line above the content', () => {
    const html = renderWorkPage(
      bundle({
        characters: chars,
        blocks: [
          {
            id: 'b1',
            chapter_id: 'ch1',
            type: 'dialogue',
            content: 'Fine.',
            order: 0,
            metadata: { type: 'dialogue', data: { speaker_id: 'me', parenthetical: 'through <teeth>' } },
          },
        ],
      }),
      META,
    );
    expect(html).toContain('<div class="paren">through &lt;teeth&gt;</div>');
  });
});

describe('renderWorkPages — chapter kinds', () => {
  it('front matter renders on the cover; standard then back matter get the chapter pages', () => {
    const chapters: PublishedChapter[] = [
      { id: 'aft', title: 'Afterword', order: 0, kind: 'afterword' },
      { id: 'std', title: 'Chapter One', order: 1, kind: 'standard' },
      { id: 'epi', title: 'Epigraph', order: 2, kind: 'epigraph' },
    ];
    const blocks: PublishedBlock[] = [
      { id: 'b1', chapter_id: 'aft', type: 'text', content: 'BACKMARKER', order: 0, metadata: { type: 'text' } },
      { id: 'b2', chapter_id: 'std', type: 'text', content: 'MIDDLEMARKER', order: 0, metadata: { type: 'text' } },
      { id: 'b3', chapter_id: 'epi', type: 'text', content: 'FRONTMARKER', order: 0, metadata: { type: 'text' } },
    ];
    const pages = renderWorkPages(bundle({ chapters, blocks }), META);
    // Front matter lives on the cover — chapter prose does not.
    expect(pages.index).toContain('FRONTMARKER');
    expect(pages.index).not.toContain('MIDDLEMARKER');
    expect(pages.index).not.toContain('BACKMARKER');
    // Reading order: standard first, back matter after.
    expect(pages.chapters).toHaveLength(2);
    expect(pages.chapters[0]).toContain('MIDDLEMARKER');
    expect(pages.chapters[1]).toContain('BACKMARKER');
  });

  it('front-matter kinds hide the title by default and center content; standard prints it', () => {
    const chapters: PublishedChapter[] = [
      { id: 'epi', title: 'EpigraphTitle', order: 0, kind: 'epigraph' },
      { id: 'std', title: 'StandardTitle', order: 1, kind: 'standard' },
      { id: 'ded', title: 'DedicationTitle', order: 2, kind: 'dedication', export_title: true },
      { id: 'aft', title: 'AfterwordTitle', order: 3, kind: 'afterword', export_title: false },
    ];
    const pages = renderWorkPages(bundle({ chapters, blocks: [] }), META);
    expect(pages.index).not.toContain('EpigraphTitle');
    expect(pages.index).toContain('DedicationTitle'); // export_title === true overrides the default
    expect(pages.index).toContain('ch-epigraph ch-center');
    expect(pages.chapters[0]).toContain('StandardTitle');
    // export_title === false hides the heading; the TOC falls back to "Chapter 2".
    expect(pages.chapters[1]).not.toContain('AfterwordTitle');
    expect(pages.index).not.toContain('AfterwordTitle');
    expect(pages.index).toContain('Chapter 2');
  });
});

describe('renderWorkPages — chaptered reading', () => {
  function threeChapterBundle(overrides: Partial<PublishBundleV1> = {}): PublishBundleV1 {
    const chapters: PublishedChapter[] = [
      { id: 'ded', title: 'For Ilka', order: 0, kind: 'dedication' },
      { id: 'c1', title: 'The Door', order: 1, kind: 'standard' },
      { id: 'c2', title: 'The Hallway', order: 2, kind: 'standard' },
      { id: 'c3', title: 'The Mirror', order: 3, kind: 'standard' },
    ];
    const blocks: PublishedBlock[] = [
      { id: 'd1', chapter_id: 'ded', type: 'text', content: 'DEDICATION PROSE', order: 0, metadata: { type: 'text' } },
      { id: 'b1', chapter_id: 'c1', type: 'text', content: 'one two three four', order: 0, metadata: { type: 'text' } },
      { id: 'b2', chapter_id: 'c2', type: 'text', content: 'five six', order: 0, metadata: { type: 'text' } },
      { id: 'b3', chapter_id: 'c3', type: 'text', content: 'seven', order: 0, metadata: { type: 'text' } },
    ];
    return bundle({ chapters, blocks, ...overrides });
  }

  it('single-chapter works keep the one-page form: no TOC, no continue slot, no chapter pages', () => {
    const pages = renderWorkPages(bundle(), META);
    expect(pages.chapters).toHaveLength(0);
    expect(pages.index).not.toContain('class="toc"');
    expect(pages.index).not.toContain('Continue reading');
    expect(pages.index).toContain('Two hearts, one soul.');
    expect(pages.index).toContain('Report this work');
  });

  it('a single non-standard chapter also stays single-page', () => {
    const pages = renderWorkPages(
      bundle({ chapters: [{ id: 'ch1', title: 'One', order: 0, kind: 'epigraph' }] }),
      META,
    );
    expect(pages.chapters).toHaveLength(0);
    expect(pages.index).not.toContain('class="toc"');
    expect(pages.index).toContain('Two hearts, one soul.');
  });

  it('multi-chapter: cover carries front-matter prose, TOC with reading times, hidden continue slot', () => {
    const pages = renderWorkPages(threeChapterBundle(), META);
    expect(pages.chapters).toHaveLength(3);

    const cover = pages.index;
    expect(cover).toContain('DEDICATION PROSE'); // front matter on the cover
    expect(cover).not.toContain('one two three four'); // chapter prose is not
    expect(cover).toContain(`href="/w/${META.id}/1"`);
    expect(cover).toContain(`href="/w/${META.id}/3"`);
    expect(cover).toContain('The Door');
    expect(cover).toContain('The Mirror');
    // Short chapters both round to ~1 min of reading.
    expect(cover).toContain('<span class="toc-words nums">~1 min</span>');
    // Continue slot: hidden until inline JS finds a position (noscript-safe).
    expect(cover).toContain('id="continue" hidden');
    expect(cover).toContain(`shelf.pos.`);
    expect(cover).toContain('Continue reading');
  });

  it('chapter page 2: slim header, prev /1, next /3, position stamp, full-work footer', () => {
    const bundle3 = threeChapterBundle({ document: { synopsis: '', pov_character_id: null } });
    const pages = renderWorkPages(bundle3, META);
    const page2 = pages.chapters[1] ?? '';
    expect(page2).toContain(`<a class="ch-back" href="/w/${META.id}">A Quiet Book</a>`);
    expect(page2).toContain('<span class="ch-count nums">2 / 3</span>');
    expect(page2).toContain(`href="/w/${META.id}/1" rel="prev"`);
    expect(page2).toContain(`href="/w/${META.id}/3" rel="next"`);
    expect(page2).toContain('five six');
    expect(page2).toContain(`localStorage.setItem('shelf.pos.'+"${META.id}",String(2))`);
    // Footer identical in shape to the cover's: whole-work word count + letter + report links.
    expect(page2).toContain(`href="/w/${META.id}/letter"`);
    expect(page2).toContain(`href="/w/${META.id}/report"`);
    expect(page2).toContain('<span class="nums">9</span> words'); // whole work incl. front matter
    // Two navs: compact top + bottom.
    expect(page2.match(/class="ch-nav /g)).toHaveLength(2);
  });

  it('first page prevs to the cover; last page shows Contents and no next', () => {
    const pages = renderWorkPages(threeChapterBundle(), META);
    const page1 = pages.chapters[0] ?? '';
    const page3 = pages.chapters[2] ?? '';
    expect(page1).toContain(`href="/w/${META.id}" rel="prev"`);
    expect(page3).toContain(`href="/w/${META.id}#toc">Contents</a>`);
    // The last page's next slot is an empty span, not a next anchor. (Check the
    // nav element specifically — the swipe script mentions the rel="next"
    // selector in a string, so a bare substring check would false-positive.)
    expect(page3).toContain('<span class="nav-next"');
    expect(page3).not.toContain('<a class="nav-next"');
    expect(page3).toContain(`localStorage.setItem('shelf.pos.'+"${META.id}",String(3))`);
  });

  it('explicit rating gates the cover AND every chapter page', () => {
    const pages = renderWorkPages(threeChapterBundle({ rating: 'explicit' }), META);
    expect(pages.index).toContain('id="age-gate"');
    expect(pages.index).toContain('<main id="work" hidden>');
    for (const page of pages.chapters) {
      expect(page).toContain('id="age-gate"');
      expect(page).toContain('<main id="work" hidden>');
      expect(page).toContain('shelf.age.ok');
    }
  });

  it('a multi-chapter work of only front matter bakes a cover with no TOC and no chapter pages', () => {
    const chapters: PublishedChapter[] = [
      { id: 'cov', title: '', order: 0, kind: 'cover' },
      { id: 'ded', title: '', order: 1, kind: 'dedication' },
    ];
    const blocks: PublishedBlock[] = [
      { id: 'b1', chapter_id: 'cov', type: 'text', content: 'COVER PROSE', order: 0, metadata: { type: 'text' } },
    ];
    const pages = renderWorkPages(bundle({ chapters, blocks }), META);
    expect(pages.chapters).toHaveLength(0);
    expect(pages.index).toContain('COVER PROSE');
    expect(pages.index).not.toContain('class="toc"');
    expect(pages.index).not.toContain('Continue reading');
  });
});

describe('renderWorkPage — chrome', () => {
  it('carries noindex, lang, rating badge, warnings, and the report link', () => {
    const html = renderWorkPage(
      bundle({ language: 'hu', rating: 'mature', warnings: ['graphic-violence', 'self-harm'] }),
      META,
    );
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<html lang="hu">');
    expect(html).toContain('badge-mature');
    // A Hungarian work gets Hungarian chrome (warnings, footer links).
    expect(html).toContain('Grafikus erőszak');
    expect(html).toContain('Önbántalmazás / öngyilkosság');
    // The report form moved to the live /w/:id/report page (Phase 1.5) —
    // baked pages only link there, so the form can evolve without re-baking.
    expect(html).toContain(`href="/w/${META.id}/report"`);
    expect(html).toContain('Mű jelentése');
    // The letter link is baked unconditionally — the live page 404s while
    // the author's mailbox is closed; bake time cannot know the future state.
    expect(html).toContain(`href="/w/${META.id}/letter"`);
    expect(html).toContain('Írj a szerzőnek');
    expect(html).not.toContain('<form');
    expect(html).toContain('prefers-reduced-motion');
  });
});

describe('countWords / firstLine', () => {
  it('counts words across text, dialogue, and scene blocks', () => {
    const b = bundle({
      blocks: [
        { id: 'b1', chapter_id: 'ch1', type: 'text', content: 'one two three', order: 0, metadata: { type: 'text' } },
        {
          id: 'b2', chapter_id: 'ch1', type: 'dialogue', content: 'four five', order: 1,
          metadata: { type: 'dialogue', data: { speaker_id: '' } },
        },
        {
          id: 'b3', chapter_id: 'ch1', type: 'scene', content: '  six  ', order: 2,
          metadata: { type: 'scene', data: { location: '', time: '', character_ids: [], mood: '' } },
        },
      ],
    });
    expect(countWords(b)).toBe(6);
  });

  it('takes the first sentence of the first standard-chapter prose block', () => {
    const b = bundle({
      chapters: [
        { id: 'cov', title: '', order: 0, kind: 'cover' },
        { id: 'ch1', title: 'One', order: 1, kind: 'standard' },
      ],
      blocks: [
        { id: 'b0', chapter_id: 'cov', type: 'text', content: 'COVER TEXT', order: 0, metadata: { type: 'text' } },
        { id: 'b1', chapter_id: 'ch1', type: 'text', content: 'It began at dusk. Nobody noticed.', order: 0, metadata: { type: 'text' } },
      ],
    });
    expect(firstLine(b)).toBe('It began at dusk.');
  });

  it('falls back to 140 chars when there is no sentence break', () => {
    const long = 'word '.repeat(60).trim();
    const b = bundle({
      blocks: [{ id: 'b1', chapter_id: 'ch1', type: 'text', content: long, order: 0, metadata: { type: 'text' } }],
    });
    expect(firstLine(b).length).toBeLessThanOrEqual(140);
    expect(firstLine(b).startsWith('word word')).toBe(true);
  });
});

describe('renderWorkPages — localized chrome', () => {
  it('an English work gets English chrome', () => {
    const html = renderWorkPage(bundle({ language: 'en', warnings: ['graphic-violence'] }), META);
    expect(html).toContain('Graphic violence');
    expect(html).toContain('Report this work');
    expect(html).toContain('Written with InkMirror');
  });

  it('a Hungarian work gets Hungarian chrome throughout', () => {
    const html = renderWorkPage(bundle({ language: 'hu', warnings: ['graphic-violence'] }), META);
    expect(html).toContain('Grafikus erőszak');
    expect(html).toContain('Mű jelentése');
    expect(html).toContain('InkMirrorral írva'); // "Written with InkMirror"
  });

  it('an unsupported language falls back to English chrome (page lang tag preserved)', () => {
    const html = renderWorkPage(bundle({ language: 'hi', warnings: ['graphic-violence'] }), META);
    expect(html).toContain('<html lang="hi"');
    expect(html).toContain('Graphic violence'); // chrome falls back to English
  });

  it('a Hungarian multi-chapter cover localizes the table of contents', () => {
    const b = bundle({
      language: 'hu',
      chapters: [
        { id: 'c1', title: 'Egy', order: 0, kind: 'standard' },
        { id: 'c2', title: 'Kettő', order: 1, kind: 'standard' },
      ],
      blocks: [
        { id: 'b1', chapter_id: 'c1', type: 'text', content: 'Első.', order: 0, metadata: { type: 'text' } },
        { id: 'b2', chapter_id: 'c2', type: 'text', content: 'Második.', order: 1, metadata: { type: 'text' } },
      ],
    });
    const { index } = renderWorkPages(b, META);
    expect(index).toContain('>Tartalom<'); // "Contents"
    expect(index).toContain('perc'); // "min" (reading time) in TOC entries
  });
});

describe('renderWorkPages — reading QoL', () => {
  // ch1 "one two three four" (4), ch2 "five six" (2), ch3 "seven eight nine" (3) → tw=9.
  const qBundle = bundle({
    chapters: [
      { id: 'c1', title: 'One', order: 0, kind: 'standard' },
      { id: 'c2', title: 'Two', order: 1, kind: 'standard' },
      { id: 'c3', title: 'Three', order: 2, kind: 'standard' },
    ],
    blocks: [
      { id: 'b1', chapter_id: 'c1', type: 'text', content: 'one two three four', order: 0, metadata: { type: 'text' } },
      { id: 'b2', chapter_id: 'c2', type: 'text', content: 'five six', order: 1, metadata: { type: 'text' } },
      { id: 'b3', chapter_id: 'c3', type: 'text', content: 'seven eight nine', order: 2, metadata: { type: 'text' } },
    ],
  });

  it('chapter pages carry the progress bar, resume/keyboard/prefetch, time-left stats, and touch nav', () => {
    const page = renderWorkPages(qBundle, META).chapters[0] ?? '';
    expect(page).toContain('id="rprog"'); // progress bar
    expect(page).toContain('id="rmeta"'); // time-left / whole-work pill
    expect(page).toContain('id="rbtt"'); // back-to-top
    expect(page).toContain('window.__rq='); // reading stats for time-left
    expect(page).toContain("'shelf.scroll.'+location.pathname"); // exact resume
    expect(page).toContain("e.key==='ArrowLeft'"); // keyboard nav
    expect(page).toContain('requestIdleCallback'); // prefetch on idle
    expect(page).toContain('ontouchstart'); // swipe + tap
  });

  it('embeds cumulative word stats so a mid-work chapter knows its place', () => {
    const page2 = renderWorkPages(qBundle, META).chapters[1] ?? '';
    expect(page2).toMatch(/window\.__rq=\{[^}]*"cw":2/);
    expect(page2).toMatch(/window\.__rq=\{[^}]*"pw":4/); // 4 words before chapter 2
    expect(page2).toMatch(/window\.__rq=\{[^}]*"tw":9/);
  });
});
