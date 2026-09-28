import { config } from './config.js';
import { buildApp } from './app.js';

const { fastify, drain } = await buildApp();

try {
  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`termhub em http://${config.host}:${config.port} (auth: ${[...config.auth.modes].join('+')})`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info(`${signal} recebido, encerrando...`);
  // Hand the sockets over first (spec 2026-09-27 §5.2): upgraded sockets would otherwise keep close() waiting until the kill.
  await drain();
  await fastify.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
