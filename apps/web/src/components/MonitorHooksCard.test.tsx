import { describe, expect, it } from 'vitest';
import { hooksInstallNote, monitorHealthNote } from './MonitorHooksCard';

describe('monitorHealthNote', () => {
  it('warns when the machine has tabs but none of them ever reported a state', () => {
    const note = monitorHealthNote({ tabs: 3, tabs_reporting: 0 }, false);
    expect(note.warn).toBe(true);
    expect(note.text).toContain('sem os hooks instalados');
  });

  it('points at the tool, not at the install, once the hooks are there', () => {
    const note = monitorHealthNote({ tabs: 3, tabs_reporting: 0 }, true);
    expect(note.warn).toBe(true);
    expect(note.text).toContain('rode algo numa tab');
  });

  it('just counts when tabs are reporting', () => {
    expect(monitorHealthNote({ tabs: 4, tabs_reporting: 2 }, true)).toEqual({ text: '2 de 4 tabs reportando estado ao monitor.', warn: false });
  });

  it('says nothing alarming when the machine has no tabs', () => {
    expect(monitorHealthNote({ tabs: 0, tabs_reporting: 0 }, true).warn).toBe(false);
  });
});

describe('hooksInstallNote', () => {
  it('names every tool it hooked, including the Cursor CLI', () => {
    const note = hooksInstallNote({ claude: 'installed', claude_dirs: ['~/.claude', '~/.claude_work'], codex: 'installed', cursor: 'installed' });
    expect(note).toBe('Claude Code: ok (~/.claude, ~/.claude_work) · Codex: ok · Cursor CLI: ok. Vale para sessões abertas a partir de agora.');
  });

  it('says a tool was not found, and asks for an agent update when the agent does not know Cursor yet', () => {
    expect(hooksInstallNote({ claude: 'installed', codex: 'skipped', cursor: 'skipped' })).toContain('Codex: não encontrado · Cursor CLI: não encontrado');
    expect(hooksInstallNote({ claude: 'installed', codex: 'skipped', cursor: 'agent_outdated' })).toContain('Cursor CLI: atualize o agente (0.4.2 ou mais novo)');
  });
});
