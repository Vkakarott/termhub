import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Raiz do monorepo (funciona tanto em src/ quanto em dist/).
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// .env: raiz do monorepo tem prioridade sobre o diretório atual.
dotenv.config({ path: [path.join(ROOT_DIR, '.env'), path.resolve(process.cwd(), '.env')] });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATA_DIR: z.string().default(path.join(ROOT_DIR, 'data')),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  // "app" | "cloudflare" | "disabled" — pode combinar: "app,cloudflare"
  AUTH_MODE: z.string().default('app'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: z
    .enum(['true', 'false', 'auto'])
    .default('auto'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  CF_TEAM_DOMAIN: z.string().optional(),
  CF_AUD: z.string().optional(),

  LOCAL_SHELL: z.string().optional(),
  TMUX_PATH: z.string().default('tmux'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export type AuthMode = 'app' | 'cloudflare' | 'disabled';

function parseAuthModes(raw: string): Set<AuthMode> {
  const modes = new Set<AuthMode>();
  for (const part of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (part === 'app' || part === 'cloudflare' || part === 'disabled') modes.add(part);
    else throw new Error(`AUTH_MODE inválido: "${part}"`);
  }
  if (modes.size === 0) modes.add('app');
  if (modes.has('disabled') && modes.size > 1) {
    throw new Error('AUTH_MODE "disabled" não pode ser combinado com outros modos');
  }
  return modes;
}

const authModes = parseAuthModes(env.AUTH_MODE);

if (authModes.has('cloudflare') && (!env.CF_TEAM_DOMAIN || !env.CF_AUD)) {
  throw new Error('AUTH_MODE cloudflare exige CF_TEAM_DOMAIN e CF_AUD');
}
if (authModes.has('disabled') && env.NODE_ENV === 'production') {
  console.warn('AVISO: AUTH_MODE=disabled em produção. Qualquer pessoa com acesso à porta tem acesso total.');
}

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.PORT,
  host: env.HOST,
  dataDir: env.DATA_DIR,
  dbPath: path.join(env.DATA_DIR, 'termhub.db'),
  publicUrl: env.PUBLIC_URL.replace(/\/$/, ''),
  auth: {
    modes: authModes,
    sessionTtlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    cookieSecure:
      env.COOKIE_SECURE === 'auto' ? env.PUBLIC_URL.startsWith('https://') : env.COOKIE_SECURE === 'true',
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null,
    cloudflare:
      env.CF_TEAM_DOMAIN && env.CF_AUD
        ? { teamDomain: env.CF_TEAM_DOMAIN.replace(/\/$/, ''), aud: env.CF_AUD }
        : null,
  },
  terminal: {
    localShell: env.LOCAL_SHELL || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/sh'),
    tmuxPath: env.TMUX_PATH,
  },
} as const;
