import { describe, expect, it } from 'vitest';
import { buildFsListScript } from './fs-script.js';

describe('buildFsListScript', () => {
  it('rejects unreadable/unexecutable directories right after the notfound check', () => {
    const s = buildFsListScript("''");
    expect(s).toContain('ERR:notfound');
    expect(s).toContain('ERR:eperm');
    expect(s.indexOf('ERR:notfound')).toBeLessThan(s.indexOf('ERR:eperm'));
  });
});
