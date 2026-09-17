import { bootSimulator, runnerAlive, runnerTail, startRunner, stopRunner } from './machine.js';
import { openMjpeg } from './mjpeg-reader.js';
import type { SimulatorBackend } from './session-manager.js';
import { openTunnel } from './tunnel.js';
import { WdaClient } from './wda-client.js';

export const realBackend: SimulatorBackend = {
  boot: bootSimulator,
  runnerAlive,
  startRunner,
  stopRunner,
  runnerTail: (m, udid) => runnerTail(m, udid, 30),
  openTunnel,
  createClient: (baseUrl) => new WdaClient(baseUrl),
  openMjpeg,
};
