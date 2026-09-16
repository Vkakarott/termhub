import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config.js';

export type { PrismaClient };

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: config.databaseUrl });
    client = new PrismaClient({
      adapter,
      log: config.isProd ? ['error'] : ['warn', 'error'],
    });
  }
  return client;
}

export async function closePrisma(): Promise<void> {
  await client?.$disconnect();
  client = null;
}
