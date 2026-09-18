import type { Machine } from '../db/repositories/types.js';
import { conflict } from '../lib/errors.js';
import { runScript, WDA_DIR } from './machine.js';

export const WDA_SETUP_SESSION = 'termhub-wda-setup';

export interface WdaSetupState {
  state: 'idle' | 'running' | 'ok' | 'failed';
  tail: string[];
  version: string | null;
}

/** Script que roda dentro do tmux na máquina: clone/pull + build-for-testing, log e status em ~/.termhub. */
export function wdaSetupScript(): string {
  return [
    '#!/bin/sh',
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    'mkdir -p "$HOME/.termhub"',
    'rm -f "$HOME/.termhub/wda-setup.status"',
    '{',
    `  if [ -d "${WDA_DIR}/.git" ]; then git -C "${WDA_DIR}" pull --ff-only; else git clone --depth 1 https://github.com/appium/WebDriverAgent "${WDA_DIR}"; fi &&`,
    `  cd "${WDA_DIR}" &&`,
    "  xcodebuild build-for-testing -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination 'generic/platform=iOS Simulator' -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO",
    '} > "$HOME/.termhub/wda-setup.log" 2>&1',
    'echo $? > "$HOME/.termhub/wda-setup.status"',
    '',
  ].join('\n');
}

const STATE_SCRIPT = `
if tmux has-session -t '=${WDA_SETUP_SESSION}' 2>/dev/null; then echo STATE:running;
elif [ -f "$HOME/.termhub/wda-setup.status" ]; then
  if [ "$(cat "$HOME/.termhub/wda-setup.status")" = 0 ]; then echo STATE:ok; else echo STATE:failed; fi;
else echo STATE:idle; fi
echo VERSION:$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "${WDA_DIR}/package.json" 2>/dev/null | head -1)
echo TAIL:
tail -n 40 "$HOME/.termhub/wda-setup.log" 2>/dev/null
exit 0`;

export function parseSetupOutput(stdout: string): WdaSetupState {
  const lines = stdout.split('\n');
  let state: WdaSetupState['state'] = 'failed';
  let version: string | null = null;
  const tail: string[] = [];
  let inTail = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (inTail) {
      if (line.trim()) tail.push(line);
      continue;
    }
    if (line.startsWith('STATE:')) {
      const s = line.slice(6).trim();
      if (s === 'idle' || s === 'running' || s === 'ok' || s === 'failed') state = s;
    } else if (line.startsWith('VERSION:')) {
      version = line.slice(8).trim() || null;
    } else if (line.startsWith('TAIL:')) {
      inTail = true;
    }
  }
  return { state, tail, version };
}

export async function wdaSetupState(machine: Machine): Promise<WdaSetupState> {
  const r = await runScript(machine, STATE_SCRIPT);
  if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || 'máquina inacessível');
  return parseSetupOutput(r.stdout);
}

export async function startWdaSetup(machine: Machine): Promise<void> {
  const current = await wdaSetupState(machine);
  if (current.state === 'running') throw conflict('Preparação do WDA já está em andamento');
  // 1) grava o script; 2) roda em tmux para sobreviver a queda do SSH/servidor.
  const write = `mkdir -p "$HOME/.termhub" && cat > "$HOME/.termhub/wda-setup.sh" <<'TERMHUB_EOF'\n${wdaSetupScript()}TERMHUB_EOF\nchmod +x "$HOME/.termhub/wda-setup.sh"`;
  const w = await runScript(machine, write);
  if (w.code !== 0) throw new Error(w.stderr.trim() || 'falha ao gravar o script de setup');
  const s = await runScript(machine, `tmux new-session -d -s ${WDA_SETUP_SESSION} 'sh "$HOME/.termhub/wda-setup.sh"'`);
  if (s.code !== 0) throw new Error(s.stderr.trim() || 'falha ao iniciar o setup no tmux');
}
