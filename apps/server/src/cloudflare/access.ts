/**
 * Cloudflare Access allowlist: the app's self-hosted application has one "allow" policy whose
 * include list is a set of e-mails (the same policy ~/cf-access-allowlist.sh manages). Invites
 * add e-mails to it and user deletion removes them, so the app is the source of truth for who
 * can reach app.termhub.dev. Every write is a read-modify-write of the whole policy, serialized
 * through a queue so two concurrent invites do not overwrite each other's e-mail.
 */

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}
interface CfApp {
  id: string;
  domain?: string;
  name?: string;
}
interface CfRule {
  email?: { email: string };
  [k: string]: unknown;
}
interface CfPolicy {
  id: string;
  name: string;
  decision: string;
  precedence?: number;
  include: CfRule[];
  exclude?: CfRule[];
  require?: CfRule[];
}

export interface AccessStatus {
  configured: boolean;
  domain?: string;
  policy?: string;
  emails: string[];
}

export class CloudflareAccessError extends Error {}

export interface AccessConfig {
  accountId: string;
  apiToken: string;
  /** Access application domain (e.g. app.termhub.dev) */
  appDomain: string;
  /** name of the allow policy whose include list holds the e-mails */
  policyName: string;
}

export interface AccessAllowlist {
  status(): Promise<AccessStatus>;
  add(email: string): Promise<void>;
  remove(email: string): Promise<void>;
}

export class CloudflareAccessClient implements AccessAllowlist {
  private appId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private cfg: AccessConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private get base(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.cfg.accountId}/access`;
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${this.cfg.apiToken}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!json || !json.success) {
      const msg = json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
      throw new CloudflareAccessError(`Cloudflare Access: ${msg}`);
    }
    return json.result;
  }

  private async resolveApp(): Promise<string> {
    if (this.appId) return this.appId;
    const apps = (await this.call<CfApp[] | null>('/apps')) ?? [];
    // Exact host first: path-scoped apps on the same host (e.g. app.termhub.dev/agent/ws, a
    // Bypass for the agent WebSocket) are listed before it by the API and carry other policies.
    const app =
      apps.find((a) => a.domain === this.cfg.appDomain) ??
      apps.find((a) => a.domain?.startsWith(`${this.cfg.appDomain}/`));
    if (!app) throw new CloudflareAccessError(`Cloudflare Access: nenhuma aplicação para ${this.cfg.appDomain}`);
    this.appId = app.id;
    return app.id;
  }

  private async policy(): Promise<CfPolicy> {
    const appId = await this.resolveApp();
    const list = (await this.call<CfPolicy[] | null>(`/apps/${appId}/policies`)) ?? [];
    const found = list.find((p) => p.name === this.cfg.policyName);
    if (!found) throw new CloudflareAccessError(`Cloudflare Access: policy "${this.cfg.policyName}" não encontrada`);
    return found;
  }

  private static emailsOf(p: CfPolicy): string[] {
    return p.include.map((r) => r.email?.email).filter((e): e is string => typeof e === 'string');
  }

  /** Serialize writes: the API has no atomic "add one e-mail", so the policy is replaced whole. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async setEmails(p: CfPolicy, emails: string[]): Promise<void> {
    const appId = await this.resolveApp();
    const keep = p.include.filter((r) => !r.email);
    const body = {
      name: p.name,
      decision: p.decision,
      precedence: p.precedence,
      include: [...keep, ...emails.map((email) => ({ email: { email } }))],
      exclude: p.exclude ?? [],
      require: p.require ?? [],
    };
    await this.call(`/apps/${appId}/policies/${p.id}`, { method: 'PUT', body });
  }

  async status(): Promise<AccessStatus> {
    const p = await this.policy();
    return { configured: true, domain: this.cfg.appDomain, policy: p.name, emails: CloudflareAccessClient.emailsOf(p) };
  }

  add(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    return this.serialized(async () => {
      const p = await this.policy();
      const emails = CloudflareAccessClient.emailsOf(p);
      if (emails.some((e) => e.toLowerCase() === email)) return;
      await this.setEmails(p, [...emails, email]);
    });
  }

  remove(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    return this.serialized(async () => {
      const p = await this.policy();
      const emails = CloudflareAccessClient.emailsOf(p);
      const next = emails.filter((e) => e.toLowerCase() !== email);
      if (next.length === emails.length) return;
      await this.setEmails(p, next);
    });
  }
}

/** No CF_ACCOUNT_ID/CF_API_TOKEN: invites still work, they just do not touch Cloudflare. */
class DisabledAllowlist implements AccessAllowlist {
  async status(): Promise<AccessStatus> {
    return { configured: false, emails: [] };
  }
  async add(): Promise<void> {}
  async remove(): Promise<void> {}
}

export function createAccessAllowlist(cfg: AccessConfig | null): AccessAllowlist {
  return cfg ? new CloudflareAccessClient(cfg) : new DisabledAllowlist();
}
