import { describe, expect, it } from 'vitest';
import { buildPasteScript, safeName, sniffImage } from './paste.js';

describe('paste', () => {
  it('detects png and jpeg signatures (needs at least 12 bytes to sniff)', () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('hello'))).toBeNull();
  });

  it('detects gif and webp signatures', () => {
    expect(sniffImage(Buffer.from('GIF89a' + '\0'.repeat(6)))).toBe('image/gif');
    const webp = Buffer.alloc(12);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    expect(sniffImage(webp)).toBe('image/webp');
  });

  it('produces a name with only safe characters, keeping the current (uppercase-preserving) extension check', () => {
    // sanitized, given an extension, prefixed with paste-<stamp>-; the original case of an
    // already-matching extension (case-insensitive) is kept as-is, not lowercased.
    expect(safeName('my file (1).PNG', 'png')).toMatch(/^paste-\d{8}-\d{6}-[A-Za-z0-9._-]+\.PNG$/);
    expect(safeName('../../etc/passwd', null)).not.toContain('/');
  });

  it('writes into the fixed paste dir and echoes the path', () => {
    const s = buildPasteScript('paste-1.png');
    expect(s).toContain('$HOME/.cache/termhub/paste');
    expect(s).toContain('cat > "$d/paste-1.png"');
    expect(s).toContain('mtime +7');
  });
});
