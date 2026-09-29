import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { tokens, type SchemeName } from '@/theme/tokens';
import { markdownStyle } from './markdown-style';

// The real renderer and its own styles: test/ui-setup.js swaps the package for a plain `Text`.
const Markdown = jest.requireActual('react-native-markdown-display').default as typeof import('react-native-markdown-display').default;
const { styles: libraryStyles } = jest.requireActual('react-native-markdown-display/src/lib/styles') as { styles: Record<string, Record<string, unknown>> };

const SCHEMES: SchemeName[] = ['dark', 'light'];
const COLOUR_KEYS = ['backgroundColor', 'borderColor', 'color'];

/** WCAG relative luminance of `#RRGGBB`, and the contrast ratio of two such colours. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };

/** Every rendered node, depth first, with the flattened style of the nodes above it (nearest first). */
type Drawn = { text: string; style: Record<string, unknown>; above: Record<string, unknown>[]; leaf: boolean };

function nodes(tree: Json | Json[] | null): Drawn[] {
  const out: Drawn[] = [];
  const textOf = (node: Json | string): string => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));
  const walk = (node: Json | string, above: Record<string, unknown>[]) => {
    if (typeof node === 'string') return;
    const style = (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<string, unknown>;
    // A leaf holds the characters themselves: the `Text` whose colour is the one they are drawn in.
    out.push({ text: textOf(node), style, above, leaf: (node.children ?? []).every((child) => typeof child === 'string') });
    for (const child of node.children ?? []) walk(child, [style, ...above]);
  };
  for (const root of Array.isArray(tree) ? tree : tree ? [tree] : []) walk(root, []);
  return out;
}

/** The quote boxes of what was rendered: the nodes that carry the quote's bar. */
const quotes = () => nodes(screen.toJSON() as Json | Json[] | null).filter((n) => n.style.borderLeftWidth === 3);

describe('markdownStyle', () => {
  it.each(SCHEMES)('a quote takes its colours from the %s palette, and its text stays readable on it', (scheme) => {
    const palette = tokens[scheme]!;
    const style = markdownStyle(scheme);
    expect(style.blockquote).toMatchObject({ backgroundColor: palette.surface2, borderColor: palette.muted });
    expect(style.body.color).toBe(palette.text);
    // AA for body text is 4.5; the library's own #F5F5F5 under the dark theme's text was 1.1.
    expect(contrast(style.body.color!, style.blockquote.backgroundColor!)).toBeGreaterThan(7);
    expect(contrast(style.body.color!, style.code_block.backgroundColor!)).toBeGreaterThan(7);
    expect(contrast(style.body.color!, style.code_inline.backgroundColor!)).toBeGreaterThan(7);
  });

  it.each(SCHEMES)('leaves none of the library\'s own colours in place (%s)', (scheme) => {
    const ours = markdownStyle(scheme) as Record<string, Record<string, unknown>>;
    const palette = Object.values(tokens[scheme]!);
    const kept: string[] = [];
    for (const [node, defaults] of Object.entries(libraryStyles))
      for (const key of COLOUR_KEYS) if (key in defaults && !palette.includes(ours[node]?.[key] as string)) kept.push(`${node}.${key}`);
    expect(kept).toEqual([]);
  });

  describe.each(SCHEMES)('rendered with the %s theme', (scheme) => {
    const palette = tokens[scheme]!;
    const show = (text: string) => render(<Markdown style={markdownStyle(scheme)}>{text}</Markdown>);

    it('draws a quote on the theme\'s surface, with the body\'s text colour', async () => {
      await show('Antes.\n\n> o rascunho que estava na caixa\n\nDepois.');
      const [quote, ...others] = quotes();
      expect(others).toEqual([]);
      expect(quote!.text).toContain('o rascunho que estava na caixa');
      expect(quote!.style).toMatchObject({ backgroundColor: palette.surface2, borderColor: palette.muted });

      const words = nodes(screen.toJSON() as Json | Json[] | null).filter((n) => n.leaf && n.text === 'o rascunho que estava na caixa');
      expect(words).toHaveLength(1);
      expect(words[0]!.style.color).toBe(palette.text);
      expect(contrast(words[0]!.style.color as string, quote!.style.backgroundColor as string)).toBeGreaterThan(7);
    });

    it('keeps a quote of several lines and paragraphs in one readable box', async () => {
      await show('> primeira linha\n> segunda linha\n>\n> outro parágrafo');
      const [quote, ...others] = quotes();
      expect(others).toEqual([]);
      expect(quote!.text).toContain('primeira linha');
      expect(quote!.text).toContain('segunda linha');
      expect(quote!.text).toContain('outro parágrafo');
      expect(quote!.style.backgroundColor).toBe(palette.surface2);
    });

    it('keeps a quote inside a list readable', async () => {
      await show('1. o texto que seria enviado:\n\n   > citação dentro da lista\n\n2. outro item');
      const [quote, ...others] = quotes();
      expect(others).toEqual([]);
      expect(quote!.text).toContain('citação dentro da lista');
      expect(quote!.style).toMatchObject({ backgroundColor: palette.surface2, borderColor: palette.muted });
    });

    it('draws code, inline and in a block, on the theme\'s surface too', async () => {
      await show('um `código` no texto\n\n```\nbloco cercado\n```\n\n    bloco recuado');
      const drawn = nodes(screen.toJSON() as Json | Json[] | null);
      for (const text of ['código', 'bloco cercado', 'bloco recuado']) {
        const node = drawn.find((n) => n.leaf && n.text === text);
        expect(node?.style).toMatchObject({ backgroundColor: palette.surface2, color: palette.text, borderColor: palette.border });
      }
    });

    it('draws rules and table lines in the theme\'s border colour, not in black', async () => {
      await show('antes\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |');
      const drawn = nodes(screen.toJSON() as Json | Json[] | null);
      const coloured = drawn.flatMap((n) => [n.style.backgroundColor, n.style.borderColor]).filter((c) => c !== undefined);
      expect(coloured.length).toBeGreaterThan(0);
      for (const colour of coloured) expect(colour).toBe(palette.border);
    });
  });
});
