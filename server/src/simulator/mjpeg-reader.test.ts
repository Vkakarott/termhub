import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openMjpeg } from './mjpeg-reader.js';

const part = (data: Buffer) =>
  Buffer.concat([Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`), data, Buffer.from('\r\n')]);

const jpegA = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const jpegB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9, 9, 0xff, 0xd9]);

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

function shutdown(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

describe('openMjpeg', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) await shutdown(server);
    server = undefined;
  });

  it('entrega os frames do stream MJPEG', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
      res.write(part(jpegA));
      res.write(part(jpegB));
      res.end();
    });
    const port = await listen(server);

    const frames: Buffer[] = [];
    const ended = new Promise<Error | undefined>((resolve) => {
      openMjpeg(port, (f) => frames.push(f), (err) => resolve(err));
    });
    expect(await ended).toBeUndefined();
    expect(frames).toEqual([jpegA, jpegB]);
  });

  it('resposta != 200 chama onEnd uma vez com erro', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const port = await listen(server);

    let calls = 0;
    const err = await new Promise<Error | undefined>((resolve) => {
      openMjpeg(
        port,
        () => {},
        (e) => {
          calls++;
          resolve(e);
        },
      );
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/500/);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });

  it('close() interrompe o stream sem chamar onEnd', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
      // Não fecha a conexão: fica "streaming" indefinidamente até o cliente desistir.
    });
    const port = await listen(server);

    let endCalled = false;
    const close = openMjpeg(
      port,
      () => {},
      () => {
        endCalled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    close();
    await new Promise((r) => setTimeout(r, 100));
    expect(endCalled).toBe(false);
  });
});
