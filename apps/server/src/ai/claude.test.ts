import { describe, expect, it } from 'vitest';
import { parseUsageBody } from './claude.js';

// Shape of https://api.anthropic.com/api/oauth/usage (values trimmed).
const body = {
  five_hour: { utilization: 22.0, resets_at: '2026-09-18T11:10:00.383593+00:00' },
  seven_day: { utilization: 74.0, resets_at: '2026-09-22T00:00:00.383614+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  limits: [
    { kind: 'session', group: 'session', percent: 22, resets_at: '2026-09-18T11:10:00.383593+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 74, resets_at: '2026-09-22T00:00:00.383614+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 92, resets_at: '2026-09-21T23:59:59.383855+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
};

describe('parseUsageBody', () => {
  it('keeps the account-wide windows in order and appends the per-model (Fable) cap', () => {
    const windows = parseUsageBody(body);
    expect(windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day', 'nimbus_quill', 'limit:weekly_scoped:Fable']);
    const fable = windows[3];
    expect(fable.label).toBe('7 dias · Fable');
    expect(fable.utilization).toBe(92);
    expect(fable.resets_at).toBe(new Date('2026-09-21T23:59:59.383855+00:00').toISOString());
  });

  it('does not duplicate unscoped limits already covered by the top-level windows', () => {
    const windows = parseUsageBody(body);
    expect(windows.filter((w) => w.key.startsWith('limit:'))).toHaveLength(1);
  });

  it('ignores limits without a percent or a readable scope', () => {
    const windows = parseUsageBody({
      limits: [
        { kind: 'weekly_scoped', group: 'weekly', scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', group: 'weekly', percent: 10, scope: { model: {}, surface: null } },
      ],
    });
    expect(windows).toEqual([]);
  });

  it('returns nothing for a payload without usage data', () => {
    expect(parseUsageBody({ extra_usage: { is_enabled: false } })).toEqual([]);
  });
});
