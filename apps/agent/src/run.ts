import os from 'node:os';
import type { HelloMessage } from '@termhub/agent-protocol';
import { connectOnce, runForever, RevokedError, ProtocolMismatchError, UpgradeRejectedError } from './client.js';
import type { AgentConfig } from './config.js';
import { createDispatcher } from './dispatch.js';
import { createPtyManager } from './pty.js';
import { handlers } from './rpc/index.js';
import { AGENT_VERSION } from './version.js';

export type SupportedOs = 'macos' | 'linux';

/** `darwin` → `macos`, `linux` → `linux`; anything else (win32, …) isn't supported yet. */
export function detectOs(platform: NodeJS.Platform = process.platform): SupportedOs | null {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return null;
}

export type HelloFields = Omit<HelloMessage, 'type' | 'protocol'>;

/** Builds the `hello` fields, probing `tools.detect` for the tool list (empty on failure). */
export async function buildHello(osName: SupportedOs): Promise<HelloFields> {
  let tools: string[] = [];
  try {
    const result = await handlers['tools.detect']({});
    tools = result.tools;
  } catch {
    tools = [];
  }
  return {
    agent_version: AGENT_VERSION,
    os: osName,
    arch: process.arch,
    hostname: os.hostname(),
    tmux: tools.includes('tmux'),
    tools,
  };
}

/**
 * A short-lived `connectOnce()` used by `status`/`doctor` to check reachability without joining
 * a real session: resolves the socket, then aborts immediately (or after `timeoutMs`, whichever
 * comes first) — never leaves a connection open.
 */
export async function checkServerConnection(
  config: Pick<AgentConfig, 'url' | 'token'>,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; error?: string }> {
  const osName = detectOs() ?? 'linux';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { closed } = await connectOnce(
      {
        url: config.url,
        token: config.token,
        hello: { agent_version: AGENT_VERSION, os: osName, arch: process.arch, hostname: os.hostname(), tmux: false, tools: [] },
        onServerMessage: () => {},
        onStream: () => {},
        log: () => {},
      },
      controller.signal,
    );
    closed.catch(() => {});
    return { ok: true };
  } catch (err) {
    if (err instanceof UpgradeRejectedError && err.status === 401) {
      return { ok: false, error: 'Token inválido ou revogado' };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface RunAgentOptions {
  signal?: AbortSignal;
  log: (msg: string, meta?: object) => void;
}

/**
 * Runs the agent in the foreground until `signal` aborts (or forever, if none is given):
 * builds `hello`, wires the PTY manager + dispatcher into `runForever()`, and drops every PTY
 * channel (`pty.closeAll()`) on each disconnect so a reconnect never inherits a stale session.
 *
 * `RevokedError`/`ProtocolMismatchError` print a pt-BR message to stderr and `process.exit(78)`
 * — matching sysvinit/launchd/systemd "don't restart me" conventions (see `service/*.ts`).
 */
export async function runAgent(config: AgentConfig, opts: RunAgentOptions): Promise<void> {
  const osName = detectOs();
  if (!osName) {
    console.error('Sistema não suportado');
    process.exit(1);
  }

  const hello = await buildHello(osName);
  const pty = createPtyManager({ log: opts.log });
  const dispatch = createDispatcher({ handlers, pty, log: opts.log });

  try {
    await runForever(
      {
        url: config.url,
        token: config.token,
        hello,
        onServerMessage: dispatch,
        onStream: (ch, data) => pty.write(ch, data),
        onDisconnect: () => pty.closeAll(),
        log: opts.log,
      },
      opts.signal,
    );
  } catch (err) {
    if (err instanceof RevokedError) {
      console.error('Token revogado. Rode: termhub-agent connect --url <url>');
      process.exit(78);
    }
    if (err instanceof ProtocolMismatchError) {
      console.error('Atualize o agente: npm i -g @termhub/agent');
      process.exit(78);
    }
    throw err;
  }
}
