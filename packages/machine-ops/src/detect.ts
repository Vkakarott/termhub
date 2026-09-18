/** Ferramentas que interessam para automação (detectadas no status). */
export const DETECT_TOOLS = ['tmux', 'claude', 'gh', 'git', 'node', 'pnpm', 'xcodebuild', 'docker', 'adb', 'python3'] as const;

const WDA_RUNNER_APP = '$HOME/.termhub/WebDriverAgent/DerivedData/Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app';
export const DETECT_SCRIPT = `echo OS:$(uname -s); for t in ${DETECT_TOOLS.join(' ')}; do command -v $t >/dev/null 2>&1 && echo CAP:$t; done; [ -d "${WDA_RUNNER_APP}" ] && echo CAP:wda; exit 0`;

export function parseDetect(stdout: string): { os: string | null; capabilities: string[] } {
  let os: string | null = null;
  const caps: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('OS:')) {
      const raw = line.slice(3).trim().toLowerCase();
      os = raw === 'darwin' ? 'macos' : raw || null;
    } else if (line.startsWith('CAP:')) caps.push(line.slice(4).trim());
  }
  return { os, capabilities: caps };
}
