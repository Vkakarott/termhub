import { shellQuote } from './shell.js';

/**
 * iOS simulator scripts (WebDriverAgent runner, `xcrun simctl`, WDA setup). The server runs them over
 * ssh/local through `runOnMachine` and the agent through `sh()`; both only ever pass values as shell
 * variables (`withVars` / env), never by interpolating into the script text.
 */

export const WDA_DIR = '$HOME/.termhub/WebDriverAgent';
export const WDA_SETUP_SESSION = 'termhub-wda-setup';

/** Same regex as `UDID_RE` in `@termhub/agent-protocol` (which cannot import this package). */
export const UDID_RE = /^[A-Fa-f0-9-]{8,64}$/;
export function assertUdid(udid: string): void {
  if (!UDID_RE.test(udid)) throw new Error(`UDID inválido: ${udid}`);
}

/** tmux session where the WDA runner of one device runs on the machine. */
export function runnerSessionName(udid: string): string {
  return `termhub-wda-${udid.slice(0, 8).toLowerCase()}`;
}

/** `A='x'; B='y'; <script>` — values single-quoted so they are data to the shell, never syntax. */
export function withVars(vars: Record<string, string>, script: string): string {
  const assigns = Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return `${assigns.join('; ')}; ${script}`;
}

export const SIMCTL_LIST_SCRIPT = 'xcrun simctl list devices -j';
/** Reads $UDID. "already booted" comes back on stdout with exit 0 (the `|| true`); the caller decides. */
export const SIMCTL_BOOT_SCRIPT = 'xcrun simctl boot "$UDID" 2>&1 || true';

/** Reads $SESSION, $UDID, $WDA_PORT, $MJPEG_PORT. Exit 1 with "duplicate session" when it already runs. */
export const WDA_RUNNER_START_SCRIPT =
  `tmux new-session -d -s "$SESSION" "cd ${WDA_DIR} && xcodebuild test-without-building -project WebDriverAgent.xcodeproj ` +
  `-scheme WebDriverAgentRunner -destination id=$UDID -derivedDataPath DerivedData USE_PORT=$WDA_PORT MJPEG_SERVER_PORT=$MJPEG_PORT"`;
/** Reads $SESSION; prints yes/no. */
export const WDA_RUNNER_ALIVE_SCRIPT = `tmux has-session -t "=$SESSION" 2>/dev/null && echo yes || echo no`;
/** Reads $SESSION, $LINES; last non-empty lines of the runner's pane. */
export const WDA_RUNNER_TAIL_SCRIPT = `tmux capture-pane -p -t "=$SESSION" 2>/dev/null | grep -v '^$' | tail -n "$LINES"`;

/** Content of ~/.termhub/wda-setup.sh: clone/pull + build-for-testing, log and status under ~/.termhub. */
export const WDA_SETUP_SH = [
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

/** Writes the setup script and starts it in tmux, unless it is already running. Prints STARTED:yes|no. */
export const WDA_SETUP_START_SCRIPT = [
  `if tmux has-session -t '=${WDA_SETUP_SESSION}' 2>/dev/null; then echo STARTED:no; exit 0; fi`,
  `mkdir -p "$HOME/.termhub" && cat > "$HOME/.termhub/wda-setup.sh" <<'TERMHUB_EOF'`,
  WDA_SETUP_SH + 'TERMHUB_EOF',
  `chmod +x "$HOME/.termhub/wda-setup.sh" && tmux new-session -d -s ${WDA_SETUP_SESSION} 'sh "$HOME/.termhub/wda-setup.sh"' && echo STARTED:yes`,
].join('\n');

/** STATE:/VERSION:/TAIL: lines; always exits 0. */
export const WDA_SETUP_STATE_SCRIPT = `
if tmux has-session -t '=${WDA_SETUP_SESSION}' 2>/dev/null; then echo STATE:running;
elif [ -f "$HOME/.termhub/wda-setup.status" ]; then
  if [ "$(cat "$HOME/.termhub/wda-setup.status")" = 0 ]; then echo STATE:ok; else echo STATE:failed; fi;
else echo STATE:idle; fi
echo VERSION:$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "${WDA_DIR}/package.json" 2>/dev/null | head -1)
echo TAIL:
tail -n 40 "$HOME/.termhub/wda-setup.log" 2>/dev/null
exit 0`;
