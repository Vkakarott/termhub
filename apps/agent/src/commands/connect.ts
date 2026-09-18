import readline from 'node:readline';
import { connectOnce, UpgradeRejectedError } from '../client.js';
import { writeConfig, type AgentConfig } from '../config.js';
import { buildHello, detectOs, runAgent } from '../run.js';
import type { Logger } from './types.js';

/** `thb_ag_` + 43 base64url characters — matches the token format the server issues. */
const TOKEN_RE = /^thb_ag_[A-Za-z0-9_-]{43}$/;

function promptToken(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Cole o token do agente: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Runs the agent in the foreground until Ctrl-C (SIGINT/SIGTERM), then exits 0. Used by `run`. */
export async function runForegroundUntilSignal(config: AgentConfig, log: Logger): Promise<never> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await runAgent(config, { signal: controller.signal, log });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  process.exit(0);
}

export interface ConnectValues {
  url?: string;
  token?: string;
}

export async function connectCommand(values: ConnectValues, log: Logger): Promise<void> {
  const url = values.url ?? process.env.TERMHUB_URL;
  if (!url) {
    console.error('Uso: termhub-agent connect --url <url> [--token <token>]');
    process.exitCode = 2;
    return;
  }

  let token = values.token ?? process.env.TERMHUB_TOKEN;
  if (!token) {
    if (!process.stdin.isTTY) {
      console.error('Uso: termhub-agent connect --url <url> --token <token>');
      process.exitCode = 2;
      return;
    }
    token = await promptToken();
  }

  if (!TOKEN_RE.test(token)) {
    console.error('Token inválido.');
    process.exitCode = 2;
    return;
  }

  const osName = detectOs();
  if (!osName) {
    console.error('Sistema não suportado');
    process.exitCode = 1;
    return;
  }

  const hello = await buildHello(osName);
  const controller = new AbortController();
  try {
    // `probe: true`: the server validates the token and hangs up (1000 probe-ok) without
    // attaching, so re-pairing on a machine whose service is still running never bumps it.
    await connectOnce({ url, token, hello: { ...hello, probe: true }, onServerMessage: () => {}, onStream: () => {}, log }, controller.signal);
    // The check succeeded — drop this probe connection; runForegroundUntilSignal() below opens
    // the real long-lived one via runAgent()/runForever().
    controller.abort();
  } catch (err) {
    if (err instanceof UpgradeRejectedError && err.status === 401) {
      console.error('Token inválido ou revogado');
    } else {
      console.error(`Não foi possível conectar: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  // The server does not hand the agent its machine id/name in v1 (only later, over the
  // established session) — stored empty until a future protocol version fills them in.
  const config: AgentConfig = { url, token, machine_id: '', machine_name: '', created_at: new Date().toISOString() };
  writeConfig(config);
  // Pairing is done: hand the terminal back. The long-lived session belongs to the service
  // (`service install`) or to an explicit `termhub-agent run`; keeping it in the foreground here
  // made users type the next command into the running agent.
  console.log('Conectado. Configuração salva.');
  console.log('Próximos passos:');
  console.log('  termhub-agent service install   # mantém o agente rodando em segundo plano');
  console.log('  termhub-agent doctor            # confere tmux e acesso às pastas');
  console.log('(ou termhub-agent run para rodar em primeiro plano)');
}
