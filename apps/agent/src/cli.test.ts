import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_VERSION } from './version.js';

let home: string;
const ORIGINAL_ENV = process.env.TERMHUB_AGENT_HOME;

/** cli.ts re-imported fresh isn't needed (main() reads env lazily through config.ts), but keep the pattern consistent with config.test.ts. */
async function freshCli() {
  return import('./cli.js');
}

describe('cli main()', () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-cli-'));
    process.env.TERMHUB_AGENT_HOME = home;
    process.exitCode = undefined;
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errors.push(String(msg));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_ENV === undefined) delete process.env.TERMHUB_AGENT_HOME;
    else process.env.TERMHUB_AGENT_HOME = ORIGINAL_ENV;
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('--version prints AGENT_VERSION and exits 0', async () => {
    const { main } = await freshCli();
    await main(['--version']);
    expect(logs.join('\n')).toContain(AGENT_VERSION);
    expect(process.exitCode).toBeUndefined();
  });

  it('--help prints pt-BR usage and exits 0', async () => {
    const { main } = await freshCli();
    await main(['--help']);
    expect(logs.join('\n')).toContain('Uso: termhub-agent');
    expect(process.exitCode).toBe(0);
  });

  it('no arguments prints usage and exits 2', async () => {
    const { main } = await freshCli();
    await main([]);
    expect(logs.join('\n')).toContain('Uso: termhub-agent');
    expect(process.exitCode).toBe(2);
  });

  it('an unknown command exits 2 with a usage message', async () => {
    const { main } = await freshCli();
    await main(['bogus']);
    expect(errors.join('\n')).toContain('Comando desconhecido: bogus');
    expect(process.exitCode).toBe(2);
  });

  it('an unknown flag exits 2', async () => {
    const { main } = await freshCli();
    await main(['status', '--nope']);
    expect(process.exitCode).toBe(2);
  });

  it('"service" with no subcommand exits 2 with usage', async () => {
    const { main } = await freshCli();
    await main(['service']);
    expect(errors.join('\n')).toContain('service install|uninstall|status');
    expect(process.exitCode).toBe(2);
  });

  it('"run" without a config exits 78 (EX_CONFIG) so a service manager stops restarting it', async () => {
    // Tests runCommand() directly (not through main()) so the mocked process.exit()'s thrown
    // sentinel is observed here, rather than being swallowed by main()'s catch-all around
    // command dispatch — a real process.exit() never returns, so that catch never sees it in
    // production; only the mock makes it throw.
    const { runCommand } = await import('./commands/run.js');
    const exitCodes: (number | undefined)[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
      throw new Error(`__process_exit_${code}__`);
    }) as never);

    await expect(runCommand(() => {})).rejects.toThrow('__process_exit_78__');

    expect(exitCodes).toEqual([78]);
    expect(errors.join('\n')).toContain('Nenhuma configuração. Rode: termhub-agent connect --url <url>');
  });

  it('main(["run"]) without a config calls process.exit(78)', async () => {
    const { main } = await freshCli();
    const exitCodes: (number | undefined)[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
      throw new Error(`__process_exit_${code}__`);
    }) as never);

    await main(['run']);

    expect(exitCodes).toEqual([78]);
  });

  it('"disconnect" removes the config and prints the pt-BR confirmation', async () => {
    const { main } = await freshCli();
    const { writeConfig } = await import('./config.js');
    writeConfig({ url: 'https://app.termhub.dev', token: 'thb_ag_' + 'a'.repeat(43), machine_id: '', machine_name: '', created_at: new Date().toISOString() });

    await main(['disconnect']);

    expect(logs.join('\n')).toContain('Configuração removida. Revogue o token no app.');
    const { readConfig } = await import('./config.js');
    expect(readConfig()).toBeNull();
  });
});
