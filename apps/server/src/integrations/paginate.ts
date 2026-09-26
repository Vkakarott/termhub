import { MAX_TICKETS_PER_SOURCE } from './types.js';

/** Follows a provider's cursor until it runs out or the cap is hit (then `truncated` says more exists). */
export async function collectPages<T, C>(
  fetchPage: (cursor: C | null) => Promise<{ items: T[]; next: C | null }>,
  max = MAX_TICKETS_PER_SOURCE,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: C | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (items.length >= max) return { items: items.slice(0, max), truncated: items.length > max || page.next !== null };
    if (page.next === null) return { items, truncated: false };
    cursor = page.next;
  }
}
