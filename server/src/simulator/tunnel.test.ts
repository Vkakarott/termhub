import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort, openTunnel } from './tunnel.js';

describe('findFreePort', () => {
  it('devolve uma porta que dá para escutar', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1024);
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
  });
});

describe('openTunnel local', () => {
  it('máquina local não abre ssh e devolve as portas remotas', async () => {
    const t = await openTunnel(
      { id: 'm', name: 'local', host: null, ssh_user: null, ssh_port: 22, type: 'local', os: null, capabilities: [], checked_at: null, created_at: '' },
      { wdaPort: 8101, mjpegPort: 9101 },
    );
    expect(t).toMatchObject({ wdaPort: 8101, mjpegPort: 9101 });
    t.close();
  });
});
