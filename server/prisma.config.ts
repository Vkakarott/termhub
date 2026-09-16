import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Carrega o .env da raiz do monorepo (mesma regra do src/config.ts).
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: [path.join(here, '..', '.env'), path.join(here, '.env')] });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // "prisma generate" (build da imagem) não precisa do banco; migrate/studio precisam.
    url: process.env.DATABASE_URL ?? 'postgresql://unset:unset@localhost:5432/unset',
  },
});
