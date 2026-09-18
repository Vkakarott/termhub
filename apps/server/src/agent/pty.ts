import { clampSize } from '@termhub/machine-ops';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { assertSessionName } from '../terminal/machine-exec.js';
import type { PtySession, PtySessionHandlers, PtySize } from '../terminal/pty-session.js';
import type { AgentPtyChannel } from './connection.js';
import type { AgentRegistry } from './registry.js';

/** A PTY that lives on the user's machine, reached over the agent's WebSocket. */
export class AgentPtySession implements PtySession {
  readonly pid: number | null = null;
  private closed = false;

  private constructor(private readonly channel: AgentPtyChannel) {}

  static async open(
    registry: AgentRegistry,
    machine: Machine,
    project: Project,
    tab: Tab,
    size: Partial<PtySize>,
    handlers: PtySessionHandlers,
  ): Promise<AgentPtySession> {
    if (tab.kind !== 'terminal' || !tab.tmux_session) throw new Error('Tab não é um terminal');
    assertSessionName(tab.tmux_session);
    const { cols, rows } = clampSize(size);
    const channel = await registry.openPty(
      machine.id,
      { session: tab.tmux_session, cwd: project.cwd, cols, rows },
      {
        onData: (data) => handlers.onData(data.toString('utf8')),
        onExit: (code) => handlers.onExit(code ?? 1),
      },
    );
    return new AgentPtySession(channel);
  }

  write(data: string | Buffer): void {
    if (this.closed) return;
    this.channel.write(data);
  }

  resize(size: Partial<PtySize>): void {
    if (this.closed) return;
    const { cols, rows } = clampSize(size);
    this.channel.resize(cols, rows);
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
  }
}
