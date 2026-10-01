import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './MachineForm';
import { api } from '../lib/api';
import { track } from '../lib/analytics';
import type { Machine } from '../lib/types';

const POLL_MS = 3000;

export type ClientOs = 'linux' | 'macos';

/**
 * Installs the agent on a Linux machine. The agent attaches every terminal to tmux, and npm builds
 * node-pty from source there (its release ships no Linux prebuild), so tmux, a C++ toolchain and
 * python3 come first, through the one package manager the machine has. `if/elif` picks exactly one
 * manager, and `fi && npm` only installs the agent when that manager succeeded — a failed apt never
 * falls through to another manager nor reaches npm. `sudo` only when not running as root.
 */
export const LINUX_INSTALL_COMMAND = [
  'SUDO=$([ "$(id -u)" -eq 0 ] || echo sudo)',
  'if command -v apt-get >/dev/null; then $SUDO apt-get update && $SUDO apt-get install -y build-essential python3 tmux',
  'elif command -v dnf >/dev/null; then $SUDO dnf group install -y "Development Tools" && $SUDO dnf install -y python3 tmux',
  'elif command -v pacman >/dev/null; then $SUDO pacman -S --noconfirm --needed base-devel python tmux',
  "else echo 'Instale tmux, make, g++ e python3 com o gerenciador de pacotes do sistema e rode o comando de novo.'; false",
  'fi && npm i -g @termhub/agent && termhub-agent --version',
].join('\n');

/**
 * Installs the agent on macOS. node-pty ships macOS prebuilds, but npm falls back to compiling it
 * when they do not load, so the Command Line Tools are checked first: `xcode-select --install`
 * opens the system installer and returns right away, hence the stop-and-rerun instead of going on.
 * Each step is grouped and joined with `&&`, so a failure stops the chain before npm.
 */
export const MACOS_INSTALL_COMMAND = [
  "{ xcode-select -p >/dev/null 2>&1 || { xcode-select --install; echo 'Conclua a instalação das Command Line Tools e rode o comando de novo.'; false; }; } &&",
  '{ command -v tmux >/dev/null || brew install tmux; } &&',
  'npm i -g @termhub/agent && termhub-agent --version',
].join('\n');

export const INSTALL_COMMANDS: Record<ClientOs, string> = { linux: LINUX_INSTALL_COMMAND, macos: MACOS_INSTALL_COMMAND };

/** Picks the tab shown first from the browser's OS: macOS on a Mac, Linux everywhere else. */
export function detectClientOs(nav: Pick<Navigator, 'platform' | 'userAgent'> & { userAgentData?: { platform?: string } } = navigator): ClientOs {
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac/i.test(platform) && !/iphone|ipad|ipod/i.test(nav.userAgent || '') ? 'macos' : 'linux';
}

const OS_LABELS: Record<ClientOs, string> = { linux: 'Linux', macos: 'macOS' };

/** The `termhub-agent connect` command the user pastes on the target machine. */
export function enrollCommand(origin: string, token: string): string {
  return `termhub-agent connect --url ${origin} --token ${token}`;
}

interface Step {
  title: string;
  command: string;
  note?: string;
  hint?: string;
  /** Rendered as a warning callout below the command (for the errors people actually hit). */
  troubleshoot?: React.ReactNode;
}

interface Props {
  machine: Machine;
  token: string;
  onConnected?: () => void;
}

function StepItem({ index, step }: { index: number; step: Step }) {
  return (
    <li>
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-4 text-[10px] font-semibold text-fg">{index}</span>
        <span className="font-medium text-fg">{step.title}</span>
      </div>
      <div className="ml-7 mt-1">
        <code className="block max-h-40 select-all overflow-auto whitespace-pre-wrap break-all rounded bg-bg-2 px-1.5 py-1 font-mono text-[11px] text-fg-muted">{step.command}</code>
        <div className="mt-0.5 flex justify-end">
          <CopyButton text={step.command} />
        </div>
        {step.note && <p className="mt-1 text-[11px] text-warn">{step.note}</p>}
        {step.hint && <p className="mt-1 text-[11px] text-fg-dim">{step.hint}</p>}
        {step.troubleshoot && (
          <div className="mt-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-[11px]">{step.troubleshoot}</div>
        )}
      </div>
    </li>
  );
}

export function AgentEnrollment({ machine, token, onConnected }: Props) {
  const [tab, setTab] = useState<ClientOs>(() => detectClientOs());
  const [online, setOnline] = useState(false);
  const [os, setOs] = useState<string | null>(null);
  const [agentVersion, setAgentVersion] = useState<string | null>(null);
  const notifiedRef = useRef(false);
  // Kept up to date in its own effect and read from the polling effect below, so that an
  // `onConnected` prop recreated on every parent render (a common case — see MachineForm,
  // which re-renders whenever DataContext changes, e.g. the 30 s status loop) does not
  // retrigger the polling effect and restart the interval / re-fire `poll()` immediately.
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // one funnel entry per enrollment shown (create or token rotation), never the machine itself
    track('machine_enroll_start');

    const poll = async () => {
      try {
        const r = await api.machines.status(machine.id);
        if (cancelled) return;
        if (r.online) {
          setOnline(true);
          setOs(r.os ?? null);
          setAgentVersion(r.agent_version ?? null);
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          if (!notifiedRef.current) {
            notifiedRef.current = true;
            track('machine_connected', { os: r.os ?? 'unknown' });
            onConnectedRef.current?.();
          }
        }
      } catch {
        // transient network/auth hiccup while waiting for the agent — keep polling
      }
    };

    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [machine.id]);

  const origin = window.location.origin;
  const steps: Step[] = [
    {
      title: tab === 'linux' ? 'Instalar tmux, ferramentas de compilação e o agente' : 'Instalar o tmux e o agente',
      command: INSTALL_COMMANDS[tab],
      hint:
        tab === 'linux'
          ? 'Precisa de Node 20+. Usa apt, dnf ou pacman (com sudo quando não for root): o npm compila o node-pty, por isso o make, o g++ e o python3.'
          : 'Precisa de Node 20+ e do Homebrew. Se faltarem as Command Line Tools, o comando abre o instalador e para: conclua e rode de novo.',
      troubleshoot: (
        <>
          <p className="font-semibold text-warn">Deu "command not found"?</p>
          <ul className="mt-1 space-y-1 text-fg">
            <li>
              Rode o comando acima de novo e veja se o <code className="rounded bg-bg-2 px-1 font-mono text-fg-muted">npm i -g</code> terminou sem erro
              {tab === 'linux' ? ' (um "gyp ERR!" ou "not found: make" quer dizer que faltam as ferramentas de compilação).' : '.'}
            </li>
            <li>
              Usa <span className="font-medium">asdf</span>? Rode{' '}
              <code className="rounded bg-bg-2 px-1 font-mono text-fg-muted">asdf reshim nodejs</code>
            </li>
            <li>
              Senão, o diretório de binários globais do npm não está no PATH:
              <code className="mt-0.5 block select-all whitespace-pre-wrap break-all rounded bg-bg-2 px-1.5 py-1 font-mono text-fg-muted">
                export PATH="$(npm prefix -g)/bin:$PATH"
              </code>
              <span className="text-fg-dim">(e adicione essa linha ao ~/.zshrc ou ~/.bashrc)</span>
            </li>
          </ul>
        </>
      ),
    },
    {
      title: 'Conectar',
      command: enrollCommand(origin, token),
      note: 'Esse token só aparece agora. Se perder, gere outro em Rotacionar token.',
    },
    {
      title: 'Instalar como serviço',
      command: 'termhub-agent service install',
      hint: tab === 'linux' ? 'sobe no boot, sem sudo; rode loginctl enable-linger $USER uma vez para seguir rodando depois do logout' : 'sobe no login, sem sudo',
    },
  ];

  return (
    <div className="space-y-3 text-sm">
      <div role="tablist" aria-label="Sistema da máquina" className="flex gap-1">
        {(Object.keys(OS_LABELS) as ClientOs[]).map((key) => (
          <button
            key={key}
            id={`enroll-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={key === tab}
            aria-controls="enroll-steps"
            className={key === tab ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTab(key)}
          >
            {OS_LABELS[key]}
          </button>
        ))}
      </div>
      <div id="enroll-steps" role="tabpanel" aria-labelledby={`enroll-tab-${tab}`} className="space-y-3">
        <ol className="space-y-3">
          {steps.map((step, i) => (
            <StepItem key={step.title} index={i + 1} step={step} />
          ))}
        </ol>
        {tab === 'macos' && (
          <p className="rounded-md border border-line bg-bg p-2 text-[11px] text-fg-dim">
            Se o projeto estiver em Documents, Desktop ou num disco externo, conceda Acesso Total ao Disco ao node quando o sistema pedir —{' '}
            <code className="font-mono">termhub-agent doctor</code> mostra o que falta.
          </p>
        )}
      </div>
      <div className="rounded-md border border-line bg-bg p-2 text-xs">
        {online ? (
          <span className="text-ok">
            conectado ✓ · {os ?? 'SO ?'} · agente {agentVersion ?? '?'}
          </span>
        ) : (
          <span className="text-fg-dim">aguardando conexão…</span>
        )}
      </div>
    </div>
  );
}
