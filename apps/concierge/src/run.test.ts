import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildArgs, runClaude } from './run.js';

const req = {
  session_id: '3f1e9b1e-0000-4000-8000-000000000001',
  resume: false,
  text: 'o que está rodando?',
  config_dir: '/home/u/.claude_pedrogoiania',
  model: null,
  token: 'thb_pat_' + 'A'.repeat(43),
  mcp_url: 'https://termhub.dev/mcp',
};

it('builds the exact argv the spec fixes, with no permission bypass', () => {
  expect(buildArgs({ ...req, mcp_config_path: '/tmp/mcp.json' })).toEqual([
    '-p',
    '--session-id', req.session_id,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', '/tmp/mcp.json',
    '--strict-mcp-config',
    '--allowed-tools', 'mcp__termhub__*',
    '--disallowed-tools', 'Bash,Read,Write,Edit,WebFetch,WebSearch',
  ]);
});

it('resumes the session and passes the model when asked', () => {
  const args = buildArgs({ ...req, resume: true, model: 'sonnet', mcp_config_path: '/tmp/mcp.json' });
  expect(args.slice(0, 6)).toEqual(['-p', '--session-id', req.session_id, '--resume', req.session_id, '--output-format']);
  expect(args.slice(-2)).toEqual(['--model', 'sonnet']);
});

it('never passes a permission bypass, whatever the input', () => {
  expect(buildArgs({ ...req, mcp_config_path: '/tmp/mcp.json' }).join(' ')).not.toContain('dangerously');
});

// The installed CLI refuses to run otherwise: "Error: When using --print,
// --output-format=stream-json requires --verbose" — this pins the flag so nobody drops it as noise.
it('passes --verbose whenever it passes --output-format stream-json', () => {
  const variants = [
    buildArgs({ ...req, mcp_config_path: '/tmp/mcp.json' }),
    buildArgs({ ...req, resume: true, model: 'sonnet', mcp_config_path: '/tmp/mcp.json' }),
  ];
  for (const args of variants) {
    if (args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'stream-json') {
      expect(args).toContain('--verbose');
    }
  }
});

// --- streaming, against a fake CLI: no login, no network, runs in CI ---
let bin: string;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'concierge-'));
  const fake = join(bin, 'claude');
  writeFileSync(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > ${bin}/argv
cat > ${bin}/stdin
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"oi"}}}'
echo '{"type":"result","session_id":"'"$2"'","usage":{"input_tokens":7}}'
`,
  );
  chmodSync(fake, 0o755);
  mkdirSync(join(bin, 'cfg'));
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

it('streams the CLI frames as lines and feeds the prompt over stdin', async () => {
  const lines: string[] = [];
  for await (const line of runClaude({ ...req, config_dir: join(bin, 'cfg') }, { cliPath: join(bin, 'claude'), tmpDir: bin })) lines.push(line);

  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]).event.delta.text).toBe('oi');
  expect(JSON.parse(lines[1]).type).toBe('result');
  // the prompt travels on stdin, so a prompt starting with "-" can never be read as a flag
  expect(readFileSync(join(bin, 'stdin'), 'utf8')).toBe('o que está rodando?');
  expect(readFileSync(join(bin, 'argv'), 'utf8')).toContain('--strict-mcp-config');
});

it('removes the per-run temp directory after a normal completion', async () => {
  const runsDir = mkdtempSync(join(bin, 'after-'));
  const lines: string[] = [];
  for await (const line of runClaude({ ...req, config_dir: join(bin, 'cfg') }, { cliPath: join(bin, 'claude'), tmpDir: runsDir })) lines.push(line);

  expect(lines).toHaveLength(2);
  // the 0600 MCP config (a live bearer token) must not outlive the run
  expect(readdirSync(runsDir)).toEqual([]);
});

it(
  'a consumer that stops early kills the child and still removes the temp directory',
  async () => {
    const runsDir = mkdtempSync(join(bin, 'early-'));
    const pidFile = join(bin, 'slow-pid');
    const slow = join(bin, 'slow-claude');
    writeFileSync(
      slow,
      `#!/bin/sh
echo $$ > ${pidFile}
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"first"}}}'
sleep 5
echo '{"type":"result","session_id":"'"$2"'"}'
`,
    );
    chmodSync(slow, 0o755);

    for await (const _line of runClaude({ ...req, config_dir: join(bin, 'cfg') }, { cliPath: slow, tmpDir: runsDir })) {
      break; // simulate an HTTP client disconnecting mid-stream
    }

    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    // SIGTERM lands asynchronously: poll briefly, but the sleeping child must not survive the disconnect
    const deadline = Date.now() + 2000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(alive).toBe(false);
    expect(readdirSync(runsDir)).toEqual([]);
  },
  8000,
);
