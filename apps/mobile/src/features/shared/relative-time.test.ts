import { relativeTime } from './relative-time';

describe('relativeTime', () => {
  it('formats agora, minutes, hours, ontem and the day/month fallback', () => {
    expect(relativeTime('2026-09-24T12:00:00Z', Date.parse('2026-09-24T12:00:20Z'))).toBe('agora');
    expect(relativeTime('2026-09-24T12:00:00Z', Date.parse('2026-09-24T12:03:00Z'))).toBe('há 3 min');
    expect(relativeTime('2026-09-24T12:00:00Z', Date.parse('2026-09-24T14:00:00Z'))).toBe('há 2 h');
    expect(relativeTime('2026-09-24T12:00:00Z', Date.parse('2026-09-25T14:00:00Z'))).toBe('ontem');
    expect(relativeTime('2026-09-19T12:00:00Z', Date.parse('2026-09-24T12:00:00Z'))).toBe('19/09');
  });
});
