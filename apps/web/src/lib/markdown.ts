import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

// The concierge's answers come from a headless agent that reads real terminal
// screens, so its text can carry anything a prompt injected into a terminal
// produced. This is the one place in apps/web where that untrusted model text
// is turned into HTML, so it is the security boundary for both the chat and
// the notes preview.
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}
