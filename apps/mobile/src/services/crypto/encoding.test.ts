import { b64url, fromB64url, fromUtf8, utf8 } from './encoding';

describe('encoding', () => {
  it('encodes bytes to base64url', () => {
    expect(b64url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
  });

  it('decodes base64url back to bytes', () => {
    expect(fromB64url('-_-_')).toEqual(new Uint8Array([251, 255, 191]));
  });

  it('round-trips every byte value 0..255', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(fromB64url(b64url(bytes))).toEqual(bytes);
  });

  it('never pads with =, for any input length', () => {
    for (let len = 0; len <= 8; len++) {
      const bytes = new Uint8Array(len).map((_, i) => i);
      expect(b64url(bytes)).not.toContain('=');
    }
  });

  it('round-trips utf8 text with non-ASCII characters', () => {
    expect(fromUtf8(utf8('máquina'))).toBe('máquina');
  });
});
