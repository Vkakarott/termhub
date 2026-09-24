import { bootSimulator, runnerAlive, runnerTail, startRunner, stopRunner } from './machine.js';
import { openMjpeg } from './mjpeg-reader.js';
import type { SimulatorBackend } from './session-manager.js';
import { openTunnel } from './tunnel.js';
import { WdaClient } from './wda-client.js';

/** The production backend; `log` receives the tunnel's metadata-only logs (never payload bytes). */
export function createRealBackend(log?: (msg: string, meta?: object) => void): SimulatorBackend {
  return {
    boot: bootSimulator,
    runnerAlive,
    startRunner,
    stopRunner,
    runnerTail: (m, udid) => runnerTail(m, udid, 30),
    openTunnel: (machine, ports) => openTunnel(machine, ports, { log }),
    createClient: (baseUrl) => new WdaClient(baseUrl),
    openMjpeg,
  };
}
