// Pure JS base64url (RFC 4648 §5) with a 64-char table: no `Buffer` (absent in the `logic`
// Jest project, plain Node with no polyfills assumed), no `atob`/`btoa` (Hermes has them, but
// this module must behave identically under the `logic` project's plain Node runtime).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REVERSE: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

/** Encodes bytes as base64url, never padded with `=`. */
export const b64url = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0b11) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) out += ALPHABET[((b1 & 0b1111) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 !== undefined) out += ALPHABET[b2 & 0b111111];
  }
  return out;
};

/** Decodes base64url (unpadded) back to bytes. */
export const fromB64url = (s: string): Uint8Array => {
  const chars = [...s].filter((c) => c in REVERSE);
  const out = new Uint8Array(Math.floor((chars.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let pos = 0;
  for (const c of chars) {
    buffer = (buffer << 6) | (REVERSE[c] ?? 0);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 encodes a string to bytes. */
export const utf8 = (s: string): Uint8Array => encoder.encode(s);

/** UTF-8 decodes bytes back to a string. */
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);
