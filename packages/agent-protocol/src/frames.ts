/** Wire format: every WebSocket message is [channel: uint32 BE][payload]. Channel 0 carries JSON control messages; n >= 1 carries raw PTY bytes. */
export const CONTROL_CHANNEL = 0;
export const HEADER_BYTES = 4;
export const MAX_CHANNELS = 64;
export const MAX_FRAME = 1024 * 1024;
export const MAX_PASTE_FRAME = 20 * 1024 * 1024 + 1024;

export function encodeFrame(ch: number, payload: Buffer | string): Buffer {
  if (!Number.isInteger(ch) || ch < 0 || ch > 0xffffffff) throw new Error(`invalid channel ${ch}`);
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt32BE(ch, 0);
  body.copy(out, HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Buffer): { ch: number; payload: Buffer } {
  if (buf.length < HEADER_BYTES) throw new Error('truncated frame');
  return { ch: buf.readUInt32BE(0), payload: buf.subarray(HEADER_BYTES) };
}
