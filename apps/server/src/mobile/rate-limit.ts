/**
 * Sliding-window rate limiter, lifted from the waitlist's `bump()` (routes/waitlist.ts)
 * into a reusable class: one window/max pair per instance, one map per instance.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /** Records an attempt for `key`; returns false once `max` attempts happened within the window. */
  take(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) return false;
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }

  /** Current attempt count for `key` within the window, without recording a new attempt. */
  peek(key: string): number {
    const now = Date.now();
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length;
  }

  reset(): void {
    this.hits.clear();
  }
}
