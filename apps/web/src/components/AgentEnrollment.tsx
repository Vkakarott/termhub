import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './MachineForm';
import { api } from '../lib/api';
import { track } from '../lib/analytics';
import type { Machine } from '../lib/types';

const POLL_MS = 3000;

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
        <code className="block max-h-20 select-all overflow-auto whitespace-pre-wrap break-all rounded bg-bg-2 px-1.5 py-1 font-mono text-[11px] text-fg-muted">{step.command}</code>
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
      title: 'Instalar o agente',
      command: 'npm i -g @termhub/agent && termhub-agent --version',
      hint: 'Precisa de Node 20+ e tmux na máquina.',
      troubleshoot: (
        <>
          <p className="font-semibold text-warn">Deu "command not found"?</p>
          <ul className="mt-1 space-y-1 text-fg">
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
    { title: 'Instalar como serviço', command: 'termhub-agent service install', hint: 'sobe no login, sem sudo' },
  ];

  return (
    <div className="space-y-3 text-sm">
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <StepItem key={step.title} index={i + 1} step={step} />
        ))}
      </ol>
      <p className="rounded-md border border-line bg-bg p-2 text-[11px] text-fg-dim">
        No macOS, se o projeto estiver em Documents, Desktop ou num disco externo, conceda Acesso Total ao Disco ao node quando o sistema pedir —{' '}
        <code className="font-mono">termhub-agent doctor</code> mostra o que falta.
      </p>
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
