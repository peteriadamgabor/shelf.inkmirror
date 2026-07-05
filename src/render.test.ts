import { describe, expect, it } from 'vitest';
import { PUBLISH_BUNDLE_KIND, PUBLISH_BUNDLE_VERSION, type PublishBundleV1, type PublishedBlock, type PublishedChapter } from './format';
import { countWords, firstLine, renderMarkedContent, renderWorkPage } from './render';

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
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
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

  it('POV speaker dialogue gets the right-aligned class, others do not', () => {
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
      // The outer wrapper is `<div class="dlg"` or `<div class="dlg dlg-pov"`
      // (the inner `.dlg-text` div would also match a bare "dlg" prefix).
      const start = Math.max(html.lastIndexOf('<div class="dlg"', end), html.lastIndexOf('<div class="dlg ', end));
      return html.slice(start, end);
    };
    const povBlock = blockAround('line b1');
    const otherBlock = blockAround('line b2');
    expect(povBlock).toContain('dlg-pov');
    expect(povBlock).toContain('--accent:var(--violet)');
    expect(otherBlock).not.toContain('dlg-pov');
    expect(otherBlock).toContain('--accent:#0d9488');
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

  it('unassigned speaker renders a teal bubble without a pill', () => {
    const html = renderWorkPage(bundle({ blocks: [dlg('b1', '', 0)] }), META);
    expect(html).toContain('style="--accent:var(--teal)"');
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

describe('renderWorkPage — chapter kinds', () => {
  it('orders front matter before standard before back matter regardless of order fields', () => {
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
    const html = renderWorkPage(bundle({ chapters, blocks }), META);
    const front = html.indexOf('FRONTMARKER');
    const middle = html.indexOf('MIDDLEMARKER');
    const back = html.indexOf('BACKMARKER');
    expect(front).toBeGreaterThan(-1);
    expect(front).toBeLessThan(middle);
    expect(middle).toBeLessThan(back);
  });

  it('front-matter kinds hide the title by default and center content; standard prints it', () => {
    const chapters: PublishedChapter[] = [
      { id: 'epi', title: 'EpigraphTitle', order: 0, kind: 'epigraph' },
      { id: 'std', title: 'StandardTitle', order: 1, kind: 'standard' },
      { id: 'ded', title: 'DedicationTitle', order: 2, kind: 'dedication', export_title: true },
      { id: 'aft', title: 'AfterwordTitle', order: 3, kind: 'afterword', export_title: false },
    ];
    const html = renderWorkPage(bundle({ chapters, blocks: [] }), META);
    expect(html).not.toContain('EpigraphTitle');
    expect(html).toContain('StandardTitle');
    expect(html).toContain('DedicationTitle'); // export_title === true overrides the default
    expect(html).not.toContain('AfterwordTitle'); // export_title === false overrides the default
    expect(html).toContain('ch-epigraph ch-center');
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
    expect(html).toContain('Graphic violence');
    expect(html).toContain('Self-harm / suicide');
    // The report form moved to the live /w/:id/report page (Phase 1.5) —
    // baked pages only link there, so the form can evolve without re-baking.
    expect(html).toContain(`href="/w/${META.id}/report"`);
    expect(html).toContain('Report this work');
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
