import { describe, expect, it } from 'vitest';
import { DETECT_SCRIPT, DETECT_TOOLS, parseDetect } from './detect.js';

describe('detect', () => {
  it('maps Darwin to macos and collects CAP lines', () => {
    expect(parseDetect('OS:Darwin\nCAP:tmux\nCAP:claude\n')).toEqual({ os: 'macos', capabilities: ['tmux', 'claude'] });
  });
  it('keeps linux lowercase and tolerates empty output', () => {
    expect(parseDetect('OS:Linux\n')).toEqual({ os: 'linux', capabilities: [] });
    expect(parseDetect('')).toEqual({ os: null, capabilities: [] });
  });
  it('probes the CLIs start_agent can launch', () => {
    expect(DETECT_TOOLS).toEqual(expect.arrayContaining(['claude', 'codex']));
  });
  it('probes the Cursor CLI, whose hooks the monitor understands', () => {
    expect(DETECT_TOOLS).toContain('cursor-agent');
  });
  it('probes every tool of the catalog', () => {
    for (const t of DETECT_TOOLS) expect(DETECT_SCRIPT).toContain(t);
    expect(DETECT_SCRIPT).toContain('CAP:wda');
  });
});
