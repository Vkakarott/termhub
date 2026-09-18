import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Raiz do monorepo (funciona tanto em src/ quanto em dist/).
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// .env: raiz do monorepo tem prioridade sobre o diretório atual.
dotenv.config({ path: [path.join(ROOT_DIR, '.env'), path.resolve(process.cwd(), '.env')] });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória (postgresql://...)'),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  // "app" | "cloudflare" | "disabled" — pode combinar: "app,cloudflare"
  AUTH_MODE: z.string().default('app'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: z
    .enum(['true', 'false', 'auto'])
    .default('auto'),

  /** create users on first Google sign-in (default role); sensible behind Cloudflare Access */
  AUTH_GOOGLE_SIGNUP: z.enum(['true', 'false']).default('false'),
  /** role name given to users created by Google sign-up */
  AUTH_DEFAULT_ROLE: z.string().default('AUTHENTICATED'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  CF_TEAM_DOMAIN: z.string().optional(),
  CF_AUD: z.string().optional(),

  // Cloudflare Access allowlist sync (invites add/remove e-mails on the app's allow policy).
  // Token scope: Account · Access: Apps and Policies · Edit.
  CF_ACCOUNT_ID: z.string().optional(),
  CF_API_TOKEN: z.string().optional(),
  /** Access application domain; defaults to PUBLIC_URL's host */
  CF_ACCESS_APP_DOMAIN: z.string().optional(),
  /** name of the allow policy whose include list holds the e-mails */
  CF_ACCESS_POLICY_NAME: z.string().default('allowlist'),

  LOCAL_SHELL: z.string().optional(),
  TMUX_PATH: z.string().default('tmux'),
  SEED_LOCAL_MACHINE: z.enum(['true', 'false']).default('true'),

  // E-mail (código de login). Sem SMTP_HOST em dev, o código é impresso no log.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('termhub <termhub@localhost>'),
  LOGIN_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(10),

  // Chave (base64, 32 bytes) para criptografar segredos das integrações. Gere com: openssl rand -base64 32
  ENCRYPTION_KEY: z.string().optional(),

  // Speech-to-text service (docker/whisper) for voice input in the terminals. Unset = feature off.
  WHISPER_URL: z.string().url().optional(),
  /** language hint passed to whisper ("auto" = detect) */
  WHISPER_LANGUAGE: z.string().default('pt'),
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
if (authModes.has('app') && env.NODE_ENV === 'production' && !env.SMTP_HOST) {
  console.warn('AVISO: SMTP_HOST não configurado — o login por código de e-mail não vai funcionar em produção.');
}

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.PORT,
  host: env.HOST,
  databaseUrl: env.DATABASE_URL,
  publicUrl: env.PUBLIC_URL.replace(/\/$/, ''),
  auth: {
    modes: authModes,
    sessionTtlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    cookieSecure:
      env.COOKIE_SECURE === 'auto' ? env.PUBLIC_URL.startsWith('https://') : env.COOKIE_SECURE === 'true',
    googleSignup: env.AUTH_GOOGLE_SIGNUP === 'true',
    defaultRole: env.AUTH_DEFAULT_ROLE,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null,
    cloudflare:
      env.CF_TEAM_DOMAIN && env.CF_AUD
        ? { teamDomain: env.CF_TEAM_DOMAIN.replace(/\/$/, ''), aud: env.CF_AUD }
        : null,
    loginCodeTtlMs: env.LOGIN_CODE_TTL_MINUTES * 60 * 1000,
  },
  cloudflareAccess:
    env.CF_ACCOUNT_ID && env.CF_API_TOKEN
      ? {
          accountId: env.CF_ACCOUNT_ID,
          apiToken: env.CF_API_TOKEN,
          appDomain: env.CF_ACCESS_APP_DOMAIN || new URL(env.PUBLIC_URL).host,
          policyName: env.CF_ACCESS_POLICY_NAME,
        }
      : null,
  email: {
    smtp: env.SMTP_HOST
      ? {
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE === 'true',
          auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
        }
      : null,
    from: env.EMAIL_FROM,
  },
  seedLocalMachine: env.SEED_LOCAL_MACHINE === 'true',
  encryptionKey: env.ENCRYPTION_KEY ?? null,
  transcription: env.WHISPER_URL ? { url: env.WHISPER_URL.replace(/\/$/, ''), language: env.WHISPER_LANGUAGE } : null,
  terminal: {
    localShell: env.LOCAL_SHELL || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/sh'),
    tmuxPath: env.TMUX_PATH,
  },
} as const;
