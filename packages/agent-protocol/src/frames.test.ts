import { describe, expect, it } from 'vitest';
import { CONTROL_CHANNEL, decodeFrame, encodeFrame } from './frames.js';

describe('frames', () => {
  it('round-trips a control frame with a JSON payload', () => {
    const buf = encodeFrame(CONTROL_CHANNEL, '{"type":"ping"}');
    expect(buf.length).toBe(4 + 15);
    expect(decodeFrame(buf)).toEqual({ ch: 0, payload: Buffer.from('{"type":"ping"}') });
  });
  it('round-trips a stream frame with raw bytes', () => {
    const bytes = Buffer.from([0x1b, 0x5b, 0x41, 0x00, 0xff]);
    const { ch, payload } = decodeFrame(encodeFrame(7, bytes));
    expect(ch).toBe(7);
    expect(payload.equals(bytes)).toBe(true);
  });
  it('supports an empty payload', () => {
    expect(decodeFrame(encodeFrame(3, Buffer.alloc(0)))).toEqual({ ch: 3, payload: Buffer.alloc(0) });
  });
  it('rejects a truncated frame', () => {
    expect(() => decodeFrame(Buffer.from([0, 0, 1]))).toThrow(/truncated/);
  });
  it('rejects a negative or non-integer channel', () => {
    expect(() => encodeFrame(-1, 'x')).toThrow();
    expect(() => encodeFrame(1.5, 'x')).toThrow();
  });
});
