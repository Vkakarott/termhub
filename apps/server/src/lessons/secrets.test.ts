import { describe, expect, it } from 'vitest';
import { containsSecret } from './secrets.js';

describe('containsSecret', () => {
  it.each(['thb_pat_abcdef123456', 'sk-ant-api03-abcdefghijklmnop', 'ghp_' + 'a'.repeat(36), 'github_pat_11ABCDEFG', 'AKIAABCDEFGHIJKLMNOP', '-----BEGIN OPENSSH PRIVATE KEY-----'])('flags %s', (s) => {
    expect(containsSecret(['ok', `valor ${s} aqui`])).toBe(true);
  });
  it('lets ordinary text through', () => {
    expect(containsSecret(['Rode prisma migrate resolve', 'sk é abreviação', 'task-12'])).toBe(false);
  });
});
