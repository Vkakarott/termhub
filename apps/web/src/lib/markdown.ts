import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Exactly the elements `marked` emits from Markdown with `gfm` and `breaks` on, and nothing else.
 * Subtracting the tags that can fetch was the wrong shape for the threat: with `img` forbidden, this
 * DOMPurify version still lets `<video poster>`, `<input type="image" src>`, `<svg><image href>` and
 * `<video src preload="auto">` through, each one a GET of an address the model chose, with no click
 * and no CSP behind it. The set of tags that can fetch keeps growing; Markdown's own output does not,
 * so that is the allowlist.
 *
 * `input` is deliberately absent — it is the tag whose `type="image"` fetches — and it is also how a
 * GFM task list renders its checkbox, so on this path `- [ ] tarefa` reads as a plain bullet. That is
 * the price, and it is paid on the chat path only.
 */
const MARKDOWN_TAGS = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

/**
 * What `marked` gives those elements: `href`/`title` on a link, `align` on a GFM table cell, `class`
 * on a fence's `code` (`language-bash`), `start` on an ordered list that does not begin at 1. None of them can make the browser fetch anything, and
 * DOMPurify still sanitises `href`'s scheme. `.prose-termhub` styles by element and relies on neither
 * `class` nor `align` today — its `th`/`td` rule already overrides the `align` hint — so those two are
 * here to keep Markdown's own output intact, not because a style needs them.
 */
const MARKDOWN_ATTR = ['href', 'title', 'align', 'class', 'start'];

export interface RenderMarkdownOptions {
  /**
   * Keep only what Markdown itself produces. The chat passes `true`: its text comes from an agent
   * that reads real terminal screens, so anything in it that can make the browser fetch a URL is an
   * exfiltration beacon whose address the model writes. The notes editor leaves this off and keeps
   * DOMPurify's defaults — it renders the user's own text, images included.
   */
  markdownOnly?: boolean;
}

// The concierge's answers come from a headless agent that reads real terminal
// screens, so its text can carry anything a prompt injected into a terminal
// produced. This is the one place in apps/web where that untrusted model text
// is turned into HTML, so it is the security boundary for both the chat and
// the notes preview.
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  const html = marked.parse(text, { async: false }) as string;
  return options.markdownOnly ? DOMPurify.sanitize(html, { ALLOWED_TAGS: MARKDOWN_TAGS, ALLOWED_ATTR: MARKDOWN_ATTR }) : DOMPurify.sanitize(html);
}
