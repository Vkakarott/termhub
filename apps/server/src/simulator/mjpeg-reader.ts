import http from 'node:http';
import { MjpegParser } from './mjpeg.js';

/**
 * Abre o stream MJPEG do WDA em 127.0.0.1:<port> (porta local do túnel) e entrega frames.
 * Devolve a função que fecha o stream. `onEnd` é chamado uma vez, com erro ou não.
 */
export function openMjpeg(port: number, onFrame: (frame: Buffer) => void, onEnd: (err?: Error) => void): () => void {
  const parser = new MjpegParser();
  let ended = false;
  const end = (err?: Error) => {
    if (ended) return;
    ended = true;
    onEnd(err);
  };
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 15_000 }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      end(new Error(`MJPEG respondeu ${res.statusCode}`));
      return;
    }
    res.on('data', (chunk: Buffer) => {
      for (const f of parser.push(chunk)) onFrame(f);
    });
    res.on('end', () => end());
    res.on('error', (e) => end(e));
  });
  req.on('timeout', () => req.destroy(new Error('MJPEG sem dados por 15s')));
  req.on('error', (e) => end(e));
  return () => {
    ended = true;
    req.destroy();
  };
}
