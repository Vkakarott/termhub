import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/**
 * A link that opens in a new tab keeps a handle on this one through `window.opener` unless it says
 * `rel="noopener"`, and `target` is an attribute DOMPurify preserves. Untrusted text is free to
 * write `<a target="_blank">`, so every anchor that carries a `target` gets the `rel` — for both
 * consumers, since the notes editor's own text is pasted from everywhere too.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A' && node.hasAttribute('target')) node.setAttribute('rel', 'noopener noreferrer');
});

export interface RenderMarkdownOptions {
  /**
   * Whether `<img>` survives. Default `true`, for the notes editor, which renders the user's own
   * text and may legitimately want a picture in it. The chat passes `false`: an answer comes from
   * an agent that reads real terminal screens, and an `<img>` it chose the URL of is a GET the
   * browser issues with no click — an exfiltration beacon whose query string the model writes.
   * There is no CSP in this repo to fall back on.
   */
  allowImages?: boolean;
}

// The concierge's answers come from a headless agent that reads real terminal
// screens, so its text can carry anything a prompt injected into a terminal
// produced. This is the one place in apps/web where that untrusted model text
// is turned into HTML, so it is the security boundary for both the chat and
// the notes preview.
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  const html = marked.parse(text, { async: false }) as string;
  // One tag, one option: `FORBID_TAGS` subtracts from the defaults, so nothing else about what is
  // allowed changes with it — and the default call stays the plain, allowlist-free sanitise.
  return options.allowImages === false ? DOMPurify.sanitize(html, { FORBID_TAGS: ['img'] }) : DOMPurify.sanitize(html);
}
