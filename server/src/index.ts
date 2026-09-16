import { config } from './config.js';
import { buildApp } from './app.js';
import { closeDb } from './db/connection.js';

const { fastify } = await buildApp();

try {
  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`termhub em http://${config.host}:${config.port} (auth: ${[...config.auth.modes].join('+')})`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  fastify.log.info(`${signal} recebido, encerrando...`);
  await fastify.close();
  closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
