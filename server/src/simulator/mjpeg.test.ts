import { describe, expect, it } from 'vitest';
import { MjpegParser } from './mjpeg.js';

const part = (data: Buffer) =>
  Buffer.concat([Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`), data, Buffer.from('\r\n')]);

const jpegA = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const jpegB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9, 9, 0xff, 0xd9]);

describe('MjpegParser', () => {
  it('frame inteiro em um chunk', () => {
    const p = new MjpegParser();
    expect(p.push(part(jpegA))).toEqual([jpegA]);
  });

  it('frame partido em vários chunks', () => {
    const p = new MjpegParser();
    const whole = part(jpegA);
    expect(p.push(whole.subarray(0, 10))).toEqual([]);
    expect(p.push(whole.subarray(10, 60))).toEqual([]);
    expect(p.push(whole.subarray(60))).toEqual([jpegA]);
  });

  it('dois frames no mesmo chunk', () => {
    const p = new MjpegParser();
    expect(p.push(Buffer.concat([part(jpegA), part(jpegB)]))).toEqual([jpegA, jpegB]);
  });

  it('cabeçalho sem Content-Length é descartado sem travar o próximo frame', () => {
    const p = new MjpegParser();
    const bad = Buffer.from('--BoundaryString\r\nContent-type: image/jpeg\r\n\r\n');
    expect(p.push(Buffer.concat([bad, part(jpegB)]))).toEqual([jpegB]);
  });

  it('frames devolvidos são cópias independentes do buffer interno', () => {
    const p = new MjpegParser();
    const [f] = p.push(part(jpegA));
    p.push(part(jpegB));
    expect(f).toEqual(jpegA);
  });
});
