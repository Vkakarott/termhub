import { describe, expect, it } from 'vitest';
import { collectPages } from './paginate.js';

const pages = (sizes: number[]) => async (cursor: number | null) => {
  const i = cursor ?? 0;
  return { items: Array.from({ length: sizes[i] }, (_, k) => `${i}-${k}`), next: i + 1 < sizes.length ? i + 1 : null };
};

describe('collectPages', () => {
  it('follows cursors until the last page', async () => {
    expect(await collectPages(pages([2, 2, 1]), 10)).toEqual({ items: ['0-0', '0-1', '1-0', '1-1', '2-0'], truncated: false });
  });
  it('stops at the cap and says truncated when more exists', async () => {
    const r = await collectPages(pages([3, 3, 3]), 5);
    expect(r.items).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
  it('exactly the cap on the last page is not truncated', async () => {
    expect((await collectPages(pages([3, 2]), 5)).truncated).toBe(false);
  });
});
