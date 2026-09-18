#!/usr/bin/env node
/**
 * Instala (ou remove) o termhub como serviço de boot.
 *  - macOS: launchd (LaunchAgent do usuário, ~/Library/LaunchAgents/com.termhub.server.plist)
 *  - Linux: systemd (unidade de usuário em ~/.config/systemd/user/termhub.service)
 *
 * Uso: npm run install-service | npm run uninstall-service
 * Antes: npm run build (o serviço roda apps/server/dist/index.js com NODE_ENV=production).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uninstall = process.argv.includes('--uninstall');
const nodeBin = process.execPath;
const entry = path.join(ROOT, 'apps', 'server', 'dist', 'index.js');
const logDir = path.join(ROOT, 'data', 'logs');

function which(bin) {
  try {
    return execSync(`which ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

if (!uninstall && !fs.existsSync(entry)) {
  console.error(`Build não encontrado em ${entry}. Rode "npm run build" primeiro.`);
  process.exit(1);
}
fs.mkdirSync(logDir, { recursive: true });

// PATH mínimo com tmux/ssh/node visíveis para o serviço.
const extraPath = [path.dirname(nodeBin), path.dirname(which('tmux') || '/usr/bin/tmux'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  .filter((p, i, a) => p && a.indexOf(p) === i)
  .join(':');

if (os.platform() === 'darwin') {
  const label = 'com.termhub.server';
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (uninstall) {
    try { run(`launchctl bootout gui/$(id -u) "${plist}"`); } catch {}
    fs.rmSync(plist, { force: true });
    console.log('Serviço removido.');
    process.exit(0);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${path.join(ROOT, 'apps', 'server')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>${extraPath}</string>
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'termhub.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'termhub.err.log')}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, xml);
  try { run(`launchctl bootout gui/$(id -u) "${plist}"`); } catch {}
  run(`launchctl bootstrap gui/$(id -u) "${plist}"`);
  console.log(`\nServiço instalado: ${plist}\nLogs: ${logDir}\nStatus: launchctl print gui/$(id -u)/${label}`);
} else if (os.platform() === 'linux') {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unit = path.join(unitDir, 'termhub.service');
  if (uninstall) {
    try { run('systemctl --user disable --now termhub'); } catch {}
    fs.rmSync(unit, { force: true });
    run('systemctl --user daemon-reload');
    console.log('Serviço removido.');
    process.exit(0);
  }
  const ini = `[Unit]
Description=termhub - terminais no navegador
After=network.target

[Service]
Type=simple
WorkingDirectory=${path.join(ROOT, 'apps', 'server')}
ExecStart=${nodeBin} ${entry}
Environment=NODE_ENV=production
Environment=PATH=${extraPath}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(unit, ini);
  run('systemctl --user daemon-reload');
  run('systemctl --user enable --now termhub');
  console.log(`\nServiço instalado: ${unit}\nLogs: journalctl --user -u termhub -f\nDica: "loginctl enable-linger $USER" para subir sem login.`);
} else {
  console.error(`SO não suportado para serviço automático: ${os.platform()}`);
  process.exit(1);
}
