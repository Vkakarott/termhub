import type { W3CActions } from './actions.js';

export class WdaError extends Error {
  name = 'WdaError';
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Orientation = 'portrait' | 'landscape';

const REQUEST_TIMEOUT_MS = 15_000;

/** Cliente HTTP mínimo do WebDriverAgent (só o que a aba usa). */
export class WdaClient {
  sessionId: string | null = null;

  constructor(
    private baseUrl: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ value: T; sessionId?: string }> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let data: { value?: unknown; sessionId?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      data = {};
    }
    if (!res.ok) {
      const v = (data.value ?? {}) as { message?: string; error?: string };
      throw new WdaError(res.status, v.message || v.error || `WDA respondeu ${res.status}`);
    }
    return { value: data.value as T, sessionId: data.sessionId };
  }

  private session(): string {
    if (!this.sessionId) throw new Error('WDA sem sessão ativa');
    return this.sessionId;
  }

  async status(): Promise<{ ready: boolean }> {
    const { value } = await this.call<{ ready?: boolean }>('GET', '/status');
    return { ready: !!value?.ready };
  }

  async createSession(): Promise<string> {
    const r = await this.call<unknown>('POST', '/session', { capabilities: { alwaysMatch: {} } });
    if (!r.sessionId) throw new Error('WDA não devolveu sessionId');
    this.sessionId = r.sessionId;
    return r.sessionId;
  }

  async deleteSession(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = null;
    if (id) await this.call('DELETE', `/session/${id}`);
  }

  async setSettings(settings: Record<string, unknown>): Promise<void> {
    await this.call('POST', `/session/${this.session()}/appium/settings`, { settings });
  }

  async windowSize(): Promise<{ width: number; height: number }> {
    const { value } = await this.call<{ width: number; height: number }>('GET', `/session/${this.session()}/window/size`);
    return { width: value.width, height: value.height };
  }

  async orientation(): Promise<Orientation> {
    const { value } = await this.call<string>('GET', `/session/${this.session()}/orientation`);
    return String(value).toUpperCase().startsWith('LANDSCAPE') ? 'landscape' : 'portrait';
  }

  async setOrientation(o: Orientation): Promise<void> {
    await this.call('POST', `/session/${this.session()}/orientation`, { orientation: o.toUpperCase() });
  }

  async actions(a: W3CActions): Promise<void> {
    await this.call('POST', `/session/${this.session()}/actions`, a);
  }

  async keys(values: string[]): Promise<void> {
    await this.call('POST', `/session/${this.session()}/wda/keys`, { value: values });
  }

  async pressButton(name: string): Promise<void> {
    await this.call('POST', `/session/${this.session()}/wda/pressButton`, { name });
  }

  async screenshotPng(): Promise<Buffer> {
    const { value } = await this.call<string>('GET', '/screenshot');
    return Buffer.from(value, 'base64');
  }
}
