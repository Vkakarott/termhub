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

  it('returns the empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});
