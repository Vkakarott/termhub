// The style `react-native-markdown-display` gets (chat redesign spec §4.2 "Markdown"): one object
// per colour scheme, built once at module load. The bubble used to build a fresh object on every
// render, which made the renderer restyle every node of the answer on every delta.
//
// The library's own styles are written for a white page (a quote on `#F5F5F5`, rules and table
// lines in black): every colour it sets is set again here from the palette, or a node keeps a light
// background under the theme's light text. markdown-style.test.tsx holds the two lists together.
import { tokens, type SchemeName } from '@/theme/tokens';

function styleFor(scheme: SchemeName) {
  const palette = tokens[scheme];
  const code = { backgroundColor: palette.surface2, color: palette.text, borderColor: palette.border };
  return {
    body: { color: palette.text, fontSize: 16 },
    // A shade off the bubble (`surface`) with a quiet bar on the left; the text keeps the body's colour.
    blockquote: { backgroundColor: palette.surface2, borderColor: palette.muted, borderLeftWidth: 3, borderRadius: 4, marginLeft: 0, marginVertical: 4, paddingHorizontal: 10 },
    code_inline: code,
    code_block: code,
    fence: code,
    hr: { backgroundColor: palette.border },
    table: { borderColor: palette.border },
    tr: { borderColor: palette.border },
    link: { color: palette.accent },
    blocklink: { borderColor: palette.border },
  };
}

export type MarkdownStyle = ReturnType<typeof styleFor>;

const STYLES: Record<SchemeName, MarkdownStyle> = { dark: styleFor('dark'), light: styleFor('light') };

export const markdownStyle = (scheme: SchemeName): MarkdownStyle => STYLES[scheme];
