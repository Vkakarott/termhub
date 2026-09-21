// Decorates the sanitised HTML `renderMarkdown` returns with a header (language + copy button) on
// every fenced code block. This runs *after* the sanitiser (see `markdown.ts`), on the one piece of
// that HTML that is still model-written text: a fence's `language-*` class, taken verbatim from the
// answer's own fence info string. Everything this module writes into the DOM goes through DOM APIs
// (`createElement`/`textContent`), never string concatenation, so even an unrestricted class value
// could not reintroduce markup — `codeLanguage`'s charset allowlist is defence in depth on top of that.

const LANGUAGE_TOKEN = /^[a-z0-9+#-]{1,20}$/i;
const FALLBACK_LABEL = 'código';
const DECORATED_ATTR = 'data-code-block';

/** The label for a fence's language class, or null when there is none to trust. */
export function codeLanguage(className: string | null): string | null {
  if (!className) return null;
  const match = /(?:^|\s)language-(\S+)/.exec(className);
  if (!match) return null;
  const token = match[1];
  return LANGUAGE_TOKEN.test(token) ? token : null;
}

/**
 * Wraps each `<pre>` in a figure with a header (language name + copy button). Input must already be
 * sanitised (`renderMarkdown(text, { markdownOnly: true })`).
 *
 * Idempotent: a `<pre>` already inside a `[data-code-block]` figure is left alone, so re-running this
 * on its own output — which happens on every streamed delta, since the caller memoises on the body's
 * text, not on whether it was decorated before — never nests a second header.
 */
export function decorateCodeBlocks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;

  for (const pre of Array.from(body.querySelectorAll('pre'))) {
    if (pre.parentElement?.hasAttribute(DECORATED_ATTR)) continue;

    const code = pre.querySelector('code');
    if (!code) continue;

    const language = codeLanguage(code.getAttribute('class')) ?? FALLBACK_LABEL;

    const figure = doc.createElement('figure');
    figure.setAttribute(DECORATED_ATTR, '');
    figure.className = 'code-block';

    const header = doc.createElement('div');
    header.className = 'code-block__header';

    const languageLabel = doc.createElement('span');
    languageLabel.setAttribute('data-code-language', '');
    languageLabel.className = 'code-block__language';
    languageLabel.textContent = language;

    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute('data-copy', '');
    button.setAttribute('aria-label', 'Copiar código');
    button.className = 'code-block__copy';

    const buttonLabel = doc.createElement('span');
    buttonLabel.setAttribute('data-copy-label', '');
    buttonLabel.textContent = 'copiar';
    button.appendChild(buttonLabel);

    header.appendChild(languageLabel);
    header.appendChild(button);

    pre.replaceWith(figure);
    figure.appendChild(header);
    figure.appendChild(pre);
  }

  return body.innerHTML;
}
