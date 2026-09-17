import { describe, expect, it } from 'vitest';
import { WdaClient, WdaError } from './wda-client.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(responder: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = responder(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('WdaClient', () => {
  it('status lê value.ready', async () => {
    const f = fakeFetch(() => ({ json: { value: { ready: true } } }));
    const c = new WdaClient('http://127.0.0.1:8100', f.fn);
    expect(await c.status()).toEqual({ ready: true });
    expect(f.calls[0]).toMatchObject({ url: 'http://127.0.0.1:8100/status', method: 'GET' });
  });

  it('createSession guarda o sessionId e as chamadas seguintes usam ele', async () => {
    const f = fakeFetch((call) => {
      if (call.url.endsWith('/session')) return { json: { sessionId: 'S1', value: {} } };
      if (call.url.endsWith('/window/size')) return { json: { value: { width: 390, height: 844 } } };
      if (call.url.endsWith('/orientation') && call.method === 'GET') return { json: { value: 'LANDSCAPE' } };
      return { json: { value: null } };
    });
    const c = new WdaClient('http://127.0.0.1:8100', f.fn);
    expect(await c.createSession()).toBe('S1');
    expect(c.sessionId).toBe('S1');
    expect(f.calls[0]).toMatchObject({ method: 'POST', body: { capabilities: { alwaysMatch: {} } } });

    expect(await c.windowSize()).toEqual({ width: 390, height: 844 });
    expect(f.calls[1].url).toBe('http://127.0.0.1:8100/session/S1/window/size');

    expect(await c.orientation()).toBe('landscape');
    await c.setOrientation('portrait');
    expect(f.calls[3]).toMatchObject({ url: 'http://127.0.0.1:8100/session/S1/orientation', method: 'POST', body: { orientation: 'PORTRAIT' } });

    await c.setSettings({ mjpegServerFramerate: 30 });
    expect(f.calls[4]).toMatchObject({ url: 'http://127.0.0.1:8100/session/S1/appium/settings', body: { settings: { mjpegServerFramerate: 30 } } });

    await c.keys(['a', '']);
    expect(f.calls[5]).toMatchObject({ url: 'http://127.0.0.1:8100/session/S1/wda/keys', body: { value: ['a', ''] } });

    await c.pressButton('home');
    expect(f.calls[6]).toMatchObject({ url: 'http://127.0.0.1:8100/session/S1/wda/pressButton', body: { name: 'home' } });

    await c.actions({ actions: [] });
    expect(f.calls[7]).toMatchObject({ url: 'http://127.0.0.1:8100/session/S1/actions', body: { actions: [] } });

    await c.deleteSession();
    expect(f.calls[8]).toMatchObject({ url: 'http://127.0.0.1:8100/session/S1', method: 'DELETE' });
    expect(c.sessionId).toBeNull();
  });

  it('métodos de sessão sem sessão lançam erro', async () => {
    const c = new WdaClient('http://127.0.0.1:8100', fakeFetch(() => ({ json: {} })).fn);
    await expect(c.keys(['a'])).rejects.toThrow(/sessão/i);
  });

  it('screenshotPng decodifica o base64 de value', async () => {
    const png = Buffer.from('fake-png');
    const f = fakeFetch(() => ({ json: { value: png.toString('base64') } }));
    const c = new WdaClient('http://127.0.0.1:8100', f.fn);
    expect(await c.screenshotPng()).toEqual(png);
    expect(f.calls[0].url).toBe('http://127.0.0.1:8100/screenshot');
  });

  it('HTTP != 2xx vira WdaError com a mensagem do WDA', async () => {
    const f = fakeFetch(() => ({ status: 404, json: { value: { error: 'invalid session id', message: 'Session does not exist' } } }));
    const c = new WdaClient('http://127.0.0.1:8100', f.fn);
    await expect(c.status()).rejects.toMatchObject({ name: 'WdaError', status: 404, message: 'Session does not exist' });
    await expect(c.status()).rejects.toBeInstanceOf(WdaError);
  });
});
