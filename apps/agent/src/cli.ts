import { parseArgs } from 'node:util';
import { connectCommand } from './commands/connect.js';
import { disconnectCommand } from './commands/disconnect.js';
import { doctorCommand } from './commands/doctor.js';
import { runCommand } from './commands/run.js';
import { serviceCommand } from './commands/service.js';
import { statusCommand } from './commands/status.js';
import type { Logger } from './commands/types.js';
import { isMainModule } from './paths.js';
import { AGENT_VERSION } from './version.js';

/** English, metadata-only (never terminal bytes) — piped to stderr, which `service install` redirects to `agent.log`. */
const log: Logger = (msg, meta) => {
  console.error(meta ? `[termhub-agent] ${msg} ${JSON.stringify(meta)}` : `[termhub-agent] ${msg}`);
};

function printHelp(): void {
  console.log(`Uso: termhub-agent <comando> [opções]

Comandos:
  connect [--url <url>] [--token <token>]   Conecta este agente ao termhub
  run                                       Roda o agente em primeiro plano
  status                                    Mostra o estado da conexão
  disconnect                                Remove a configuração local
  service install|uninstall|status          Gerencia o serviço do sistema
  doctor [caminhos...]                      Diagnostica problemas comuns

Opções:
  --url <url>       URL do servidor termhub (ou $TERMHUB_URL)
  --token <token>   Token do agente (ou $TERMHUB_TOKEN)
  --json            Saída em JSON (status, doctor)
  --version         Mostra a versão e sai
  --help            Mostra esta ajuda e sai`);
}

function printVersion(): void {
  console.log(`termhub-agent ${AGENT_VERSION}`);
}

interface ParsedValues {
  url?: string;
  token?: string;
  version?: boolean;
  help?: boolean;
  json?: boolean;
}

/** Parses argv and dispatches to a command. Exported (rather than only run as a side effect) so `cli.test.ts` can drive it directly without spawning a built binary. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let values: ParsedValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        version: { type: 'boolean' },
        help: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }) as { values: ParsedValues; positionals: string[] });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (values.version) {
    printVersion();
    return;
  }

  if (values.help || positionals.length === 0) {
    printHelp();
    process.exitCode = values.help ? 0 : 2;
    return;
  }

  const [cmd, ...rest] = positionals;

  try {
    switch (cmd) {
      case 'connect':
        await connectCommand({ url: values.url, token: values.token }, log);
        break;
      case 'run':
        await runCommand(log);
        break;
      case 'status':
        await statusCommand(!!values.json);
        break;
      case 'disconnect':
        disconnectCommand();
        break;
      case 'service':
        await serviceCommand(rest[0]);
        break;
      case 'doctor':
        await doctorCommand(rest, !!values.json);
        break;
      default:
        console.error(`Comando desconhecido: ${cmd}`);
        printHelp();
        process.exitCode = 2;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Only run when this module is the entry point (`node dist/cli.js`, or `tsx src/cli.ts` in
// dev, or — the case that matters most — `termhub-agent` resolved through the symlink
// `npm i -g` drops in the global bin dir) — not when `cli.test.ts` imports `main` directly to
// drive it with fake argv. isMainModule() resolves symlinks so the global-install case matches.
if (isMainModule(import.meta.url, process.argv[1])) {
  void main();
}
