import { describe, expect, it } from 'vitest';
import { parseQuotaBuckets, parseQuotaSummary } from './code-assist.js';

describe('parseQuotaSummary', () => {
  it('turns retrieveUserQuotaSummary groups into 5h / weekly windows', () => {
    const windows = parseQuotaSummary({
      groups: [
        {
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-09-25T08:11:39Z', remainingFraction: 1 },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-09-18T13:11:39Z', remainingFraction: 0.25 },
          ],
        },
      ],
    });
    expect(windows).toEqual([
      { key: 'gemini-weekly', label: '7 dias', utilization: 0, resets_at: '2026-09-25T08:11:39.000Z' },
      { key: 'gemini-5h', label: '5 horas', utilization: 75, resets_at: '2026-09-18T13:11:39.000Z' },
    ]);
  });

  it('prefixes the group name when the summary has several groups', () => {
    const windows = parseQuotaSummary({
      groups: [{ displayName: 'Claude', buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 0.5 }] }],
    });
    expect(windows[0].label).toBe('5 horas · Claude');
    expect(windows[0].utilization).toBe(50);
  });

  it('skips buckets without remainingFraction and payloads without groups', () => {
    expect(parseQuotaSummary({ groups: [{ buckets: [{ bucketId: 'x', window: '5h' }] }] })).toEqual([]);
    expect(parseQuotaSummary({})).toEqual([]);
  });
});

describe('parseQuotaBuckets', () => {
  it('turns retrieveUserQuota buckets into per-model windows', () => {
    const windows = parseQuotaBuckets({
      buckets: [{ tokenType: 'WTUS', modelId: 'claude-opus-4-6-thinking', resetTime: '2026-09-18T13:11:39Z', remainingFraction: 0.1 }],
    });
    expect(windows).toEqual([{ key: 'claude-opus-4-6-thinking:WTUS', label: 'claude-opus-4-6-thinking · wtus', utilization: 90, resets_at: '2026-09-18T13:11:39.000Z' }]);
  });
});
