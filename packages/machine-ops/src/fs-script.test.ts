import { describe, expect, it } from 'vitest';
import { buildFsListScript, buildMkdirScript } from './fs-script.js';

describe('buildFsListScript', () => {
  it('checks notfound, then notdir, then eperm — so a readable regular file is "not a directory", not "no access"', () => {
    const s = buildFsListScript("''");
    expect(s).toContain('ERR:notfound');
    expect(s).toContain('ERR:notdir');
    expect(s).toContain('ERR:eperm');
    expect(s.indexOf('ERR:notfound')).toBeLessThan(s.indexOf('ERR:notdir'));
    expect(s.indexOf('ERR:notdir')).toBeLessThan(s.indexOf('ERR:eperm'));
  });
});

describe('buildMkdirScript', () => {
  it('creates only the leaf by default (parent must already exist)', () => {
    const s = buildMkdirScript("'/tmp'", "'new'");
    expect(s).toContain('mkdir -- "$N"');
    expect(s).not.toContain('mkdir -p');
    expect(s).toContain('ERR:parent');
  });

  it('recursive: uses mkdir -p on the full path, so a missing parent is created too', () => {
    const s = buildMkdirScript("'/tmp/a/b'", "'c'", { recursive: true });
    expect(s).toContain('mkdir -p -- "$P/$N"');
    expect(s).toContain('ERR:exists');
    expect(s).toContain('ERR:denied');
  });

  it('recursive: false is byte-identical to the default', () => {
    expect(buildMkdirScript("'/tmp'", "'new'", { recursive: false })).toBe(buildMkdirScript("'/tmp'", "'new'"));
  });
});
