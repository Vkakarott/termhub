import { CONTROL_CHARS_RE, FORMAT_CHARS_RE } from '../chat/tab-question-payload.js';

export const ITEM_TEXT_MAX = 1200;
export const EXCERPT_MAX = 600;

/**
 * Clean memory text: replace control and format characters with spaces (but keep newlines),
 * collapse runs of spaces, and trim. Each line is cleaned independently so newlines survive.
 */
export function cleanMemoryText(s: string): string {
  return s
    .split('\n')
    .map((line) => {
      // Replace control and format chars with spaces
      const cleaned = line.replace(CONTROL_CHARS_RE, ' ').replace(FORMAT_CHARS_RE, ' ');
      // Collapse runs of spaces and trim
      return cleaned.replace(/\s+/g, ' ').trim();
    })
    .join('\n');
}

/**
 * Combine title and text for embedding in memory, cleaned.
 */
export function memoryText(item: { title: string; text: string }): string {
  return `${item.title}\n${item.text}`;
}

/**
 * Create an excerpt from text: cleaned, cut at max length with ellipsis if truncated.
 */
export function excerpt(s: string, max = EXCERPT_MAX): string {
  const cleaned = cleanMemoryText(s);
  if (cleaned.length <= max) {
    return cleaned;
  }
  return cleaned.slice(0, max - 1) + '…';
}
