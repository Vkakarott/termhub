import { z } from 'zod';

/**
 * Setup do projeto (ProjectSetup.data). Versionado: ao mudar o formato, incremente
 * SETUP_VERSION e trate a migração em normalizeSetup().
 */
export const SETUP_VERSION = 1;

const providerEnum = z.enum(['github', 'linear', 'jira']);

export const repoSchema = z.object({
  integration_id: z.string().min(1).nullable().default(null),
  /** owner/repo */
  full_name: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'use owner/repo').nullable().default(null),
  base_branch: z.string().trim().min(1).max(100).default('main'),
  /** placeholders: {ticket} {slug} */
  branch_pattern: z.string().trim().min(1).max(100).default('{ticket}-{slug}'),
  draft_pr: z.boolean().default(true),
});

export const ticketsSchema = z.object({
  provider: providerEnum,
  integration_id: z.string().min(1),
  scope: z.string().trim().min(1).max(200),
  filter: z.string().trim().max(500).nullable().default(null),
  include_done: z.boolean().default(false),
  /** sincronizar automaticamente a cada N minutos (0 = manual) */
  sync_minutes: z.number().int().min(0).max(1440).default(0),
});

export const runnerSchema = z.object({
  /** máquina onde a automação roda (null = a máquina do projeto) */
  machine_id: z.string().min(1).nullable().default(null),
  /** diretório de trabalho no runner (null = cwd do projeto) */
  cwd: z.string().trim().max(1024).nullable().default(null),
  /** comando rodado antes de cada run (ex.: pnpm install) */
  setup_command: z.string().trim().max(2000).nullable().default(null),
  /** usar git worktree por run (isola branches) */
  worktree: z.boolean().default(true),
});

export const agentSchema = z.object({
  command: z.string().trim().min(1).max(200).default('claude'),
  plugins: z.array(z.string().trim().min(1).max(100)).default(['superpowers']),
  model: z.string().trim().max(100).nullable().default(null),
  extra_args: z.string().trim().max(1000).nullable().default(null),
});

export const verifySchema = z.object({
  type: z.enum(['none', 'ios-simulator', 'web-screenshot', 'command']).default('none'),
  /** command: comando que gera evidência; web-screenshot: URL; ios-simulator: nome do simulador */
  target: z.string().trim().max(2000).nullable().default(null),
  build_command: z.string().trim().max(2000).nullable().default(null),
});

export const decisionMode = z.enum(['ask', 'auto']);
export const approvalsSchema = z.object({
  spec: decisionMode.default('ask'),
  plan: decisionMode.default('ask'),
  pr: decisionMode.default('ask'),
  merge: decisionMode.default('ask'),
  tool_permissions: decisionMode.default('ask'),
  questions: decisionMode.default('ask'),
});

export const setupSchema = z.object({
  repo: repoSchema.nullable().default(null),
  tickets: ticketsSchema.nullable().default(null),
  runner: runnerSchema.default({}),
  agent: agentSchema.default({}),
  verify: verifySchema.default({}),
  approvals: approvalsSchema.default({}),
});

export type ProjectSetupData = z.infer<typeof setupSchema>;

/** Aplica defaults/migrações a um JSON salvo (pode ser de versão anterior). */
export function normalizeSetup(raw: unknown, _version: number): ProjectSetupData {
  const parsed = setupSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // formato desconhecido/corrompido: volta ao default sem perder o que for válido campo a campo
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(setupSchema.shape) as (keyof typeof setupSchema.shape)[]) {
    const r = setupSchema.shape[key].safeParse(obj[key]);
    out[key] = r.success ? r.data : setupSchema.shape[key].parse(undefined);
  }
  return out as ProjectSetupData;
}
