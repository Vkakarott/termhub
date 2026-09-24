import net from 'node:net';

export interface Tunnel {
  wdaPort: number;
  mjpegPort: number;
  close(): void;
  onClose(cb: (err?: Error) => void): void;
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('sem porta livre'))));
    });
  });
}
