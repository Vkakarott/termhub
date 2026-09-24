import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
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
      { id: 'm', name: 'local', host: null, ssh_user: null, ssh_port: 22, type: 'local', os: null, capabilities: [], checked_at: null, owner_id: null, owner_name: null, created_at: '' },
      { wdaPort: 8101, mjpegPort: 9101 },
    );
    expect(t).toMatchObject({ wdaPort: 8101, mjpegPort: 9101 });
    t.close();
  });
});

const sshMachine = (): Machine => ({
  id: 'm',
  name: 'mac',
  host: '127.0.0.1',
  ssh_user: 'pedro',
  ssh_port: 22,
  type: 'ssh',
  os: null,
  capabilities: [],
  checked_at: null,
  owner_id: null,
  owner_name: null,
  created_at: '',
});

function writeScript(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('openTunnel agent', () => {
  it('máquina de agente offline falha com a mensagem do agente, sem abrir ssh', async () => {
    const machine = { ...sshMachine(), type: 'agent' as const, host: null, ssh_user: null };
    await expect(openTunnel(machine, { wdaPort: 8101, mjpegPort: 9101 }, { sshBin: '/nonexistent/ssh' })).rejects.toThrow('Agente desconectado');
  });
});

describe('openTunnel ssh (stub)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-ssh-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('binário inexistente rejeita sem derrubar o processo', async () => {
    await expect(
      openTunnel(sshMachine(), { wdaPort: 8101, mjpegPort: 9101 }, { sshBin: '/nonexistent/ssh-binary' }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('ssh que sai com erro rejeita com a mensagem do stderr', async () => {
    const bin = writeScript(dir, 'ssh-auth-fail.sh', 'echo "auth failed" >&2\nexit 255');
    await expect(openTunnel(sshMachine(), { wdaPort: 8101, mjpegPort: 9101 }, { sshBin: bin })).rejects.toThrow(/auth failed/);
  });

  it('timeout de prontidão rejeita e mata o processo órfão', async () => {
    const bin = writeScript(dir, 'ssh-hang.sh', 'exec sleep 5');
    let pid: number | undefined;
    try {
      await openTunnel(sshMachine(), { wdaPort: 8101, mjpegPort: 9101 }, { sshBin: bin, readyTimeoutMs: 300 });
      throw new Error('deveria ter rejeitado');
    } catch (e) {
      expect((e as Error).message).toMatch(/não ficou pronto/);
      pid = (e as Error & { pid?: number }).pid;
    }
    expect(pid).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(isRunning(pid as number)).toBe(false);
  });
});
