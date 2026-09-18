# Aba de simulador iOS (WebDriverAgent) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma aba nova por projeto que mostra e controla um simulador iOS rodando numa máquina Mac, via WebDriverAgent (WDA) com MJPEG.

**Architecture:** O servidor sobe o runner do WDA numa sessão tmux da máquina (via SSH, como os terminais), abre um túnel `ssh -N -L` até as portas do WDA, lê o stream MJPEG e distribui frames por um WebSocket novo (`/ws/sim/<tabId>`); comandos (toque, teclas, botões) chegam pelo mesmo WS e viram chamadas HTTP no WDA. O navegador desenha os frames num `<canvas>`.

**Tech Stack:** Node 22 + Fastify + `ws` + Prisma (Postgres) no servidor; React + Vite no web; `vitest` (novo) para testes do servidor; `xcrun simctl`, `xcodebuild`, `tmux`, `ssh` na máquina Mac.

**Spec:** `docs/superpowers/specs/2026-09-17-ios-simulator-tab-design.md`

## Global Constraints

- Servidor roda em container Alpine com `openssh-client` e `tmux` (Dockerfile). Só sai do container via `ssh` (chave em `~/.ssh`), usando `sshBaseArgs()` de `server/src/terminal/machine-exec.ts`.
- Todo comando na máquina passa por `runOnMachine(machine, { file, args }, remoteCommand, timeoutMs)` (sem PTY). Para máquina `local` roda `file`/`args`; para `ssh` roda `remoteCommand` no shell remoto.
- Checkout do WDA fica em `~/.termhub/WebDriverAgent`; Runner compilado em `DerivedData/Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app` (é um diretório).
- Portas no Mac: `wdaPort = 8100 + fnv1a(udid) % 100`, `mjpegPort = 9100 + fnv1a(udid) % 100`.
- Sessão tmux do runner: `termhub-wda-<8 primeiros chars do udid, minúsculo>`. Do setup: `termhub-wda-setup`.
- Encerramento por ociosidade: 5 minutos após o último viewer sair. Espera do `/status`: até 90 s, poll a cada 1 s.
- WS: acima de 1 MB em `ws.bufferedAmount` descarta o frame. Frames nunca são enfileirados por viewer.
- Framing do MJPEG do WDA (verificado): `--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>`.
- Mensagens de erro e textos de UI em português, como o resto do app.
- Nunca logar frames nem texto digitado; só metadados (tabId, machineId, udid, portas).
- Commits pequenos, mensagens em português, terminando com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Desvio da spec, decidido aqui: teclas especiais vão do cliente como `{ type: 'key', name: 'Enter' }` e o servidor mapeia para o código W3C (`server/src/simulator/keys.ts`), para o mapa ficar testado. Texto imprimível continua como `{ type: 'keys', text }`.

## Estrutura de arquivos

Servidor (`server/src`):

| Arquivo | Responsabilidade |
|---|---|
| `simulator/ports.ts` | hash fnv1a → portas e nome da sessão tmux do runner |
| `simulator/mjpeg.ts` | `MjpegParser`: bytes → frames JPEG completos |
| `simulator/actions.ts` | tap/drag → W3C actions |
| `simulator/keys.ts` | nome de tecla do navegador → código W3C do WDA |
| `simulator/wda-client.ts` | `WdaClient`: HTTP do WDA (status, sessão, settings, actions, keys, botões, orientação, screenshot) |
| `simulator/machine.ts` | comandos na máquina: listar/bootar simuladores, runner em tmux, tail |
| `simulator/setup.ts` | instalar/compilar o WDA na máquina (tmux + log + status) |
| `simulator/tunnel.ts` | `ssh -N -L` do container até o WDA; porta livre |
| `simulator/session-manager.ts` | ciclo de vida por máquina+udid, refcount, ociosidade, recuperação |
| `simulator/ws.ts` | rota `/ws/sim/<tabId>`: viewer, controle de fluxo, comandos |
| `ws/router.ts` | roteador único de `upgrade` (auth, origem, 404) usado por terminais e simulador |
| `terminal/ws.ts` | passa a registrar no roteador em vez de ouvir `upgrade` direto |
| `terminal/machine-exec.ts` | detecção `wda` em `capabilities` |
| `routes/machines.ts`, `routes/projects.ts`, `routes/tabs.ts` | endpoints novos |
| `prisma/schema.prisma` + migration | `Tab.kind`, `Tab.simulatorUdid`, `tmuxSession` opcional |

Web (`web/src`):

| Arquivo | Responsabilidade |
|---|---|
| `lib/types.ts`, `lib/api.ts` | tipos e chamadas novas |
| `lib/simulator-connection.ts` | WS do simulador com reconexão |
| `components/SimulatorView.tsx` | canvas, barra de ações, seletor de aparelho, input |
| `components/SimulatorSetupCard.tsx` | bloco "Simulador iOS" na edição da máquina |
| `components/TabBar.tsx`, `components/TerminalsView.tsx`, `components/MachineForm.tsx` | integração |

---

### Task 1: vitest no server + `ports.ts`

**Files:**
- Modify: `server/package.json`, `server/tsconfig.json`, `package.json` (raiz), `.github/workflows/*.yml` (job `check`)
- Create: `server/src/simulator/ports.ts`, `server/src/simulator/ports.test.ts`

**Interfaces:**
- Produces: `fnv1a(s: string): number`, `wdaPorts(udid: string): { wdaPort: number; mjpegPort: number }`, `runnerSessionName(udid: string): string`

- [ ] **Step 1: Instalar vitest e configurar scripts**

```bash
cd /Volumes/Extra/projects/8020/termhub && npm i -D vitest@^3 -w server
```

Em `server/package.json`, dentro de `"scripts"`, adicione:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Em `server/tsconfig.json` adicione, ao lado de `"include": ["src"]`:

```json
"exclude": ["src/**/*.test.ts"]
```

No `package.json` da raiz, em `"scripts"`, adicione `"test": "npm test -w server"`.

No workflow de CI (arquivo em `.github/workflows/`), no job `check`, logo depois do passo "Gerar Prisma Client", adicione:

```yaml
      - name: Testes server
        run: npm test -w server
```

- [ ] **Step 2: Escrever o teste que falha**

`server/src/simulator/ports.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fnv1a, runnerSessionName, wdaPorts } from './ports.js';

describe('ports', () => {
  it('fnv1a é determinístico e diferente para strings diferentes', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });

  it('portas ficam na faixa 8100-8199 / 9100-9199 e são estáveis', () => {
    const udid = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
    const p = wdaPorts(udid);
    expect(p.wdaPort).toBeGreaterThanOrEqual(8100);
    expect(p.wdaPort).toBeLessThan(8200);
    expect(p.mjpegPort - p.wdaPort).toBe(1000);
    expect(wdaPorts(udid.toLowerCase())).toEqual(p);
  });

  it('nome da sessão tmux usa os 8 primeiros chars do udid em minúsculas', () => {
    expect(runnerSessionName('BAE07EB5-8CA8-4C6E-819A-A0240342FF00')).toBe('termhub-wda-bae07eb5');
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npx vitest run src/simulator/ports.test.ts -w server` (ou `cd server && npx vitest run src/simulator/ports.test.ts`)
Expected: FAIL, módulo `./ports.js` não encontrado.

- [ ] **Step 4: Implementar**

`server/src/simulator/ports.ts`:

```ts
/** Hash FNV-1a 32 bits (determinístico, sem dependências). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface WdaPorts {
  wdaPort: number;
  mjpegPort: number;
}

/** Portas do WDA na máquina, derivadas do UDID (sem estado persistido). */
export function wdaPorts(udid: string): WdaPorts {
  const h = fnv1a(udid.toUpperCase()) % 100;
  return { wdaPort: 8100 + h, mjpegPort: 9100 + h };
}

/** Sessão tmux onde o runner do WDA roda na máquina. */
export function runnerSessionName(udid: string): string {
  return `termhub-wda-${udid.slice(0, 8).toLowerCase()}`;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/ports.test.ts`
Expected: 3 passed. Também: `npm run typecheck -w server` sem erros.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/tsconfig.json package.json package-lock.json .github/workflows server/src/simulator/ports.ts server/src/simulator/ports.test.ts
git commit -m "Simulador: vitest no server e portas do WDA derivadas do UDID

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: parser do MJPEG

**Files:**
- Create: `server/src/simulator/mjpeg.ts`, `server/src/simulator/mjpeg.test.ts`

**Interfaces:**
- Produces: `class MjpegParser { push(chunk: Buffer): Buffer[] }` — devolve os frames completos que ficaram prontos com esse chunk; guarda o resto.

- [ ] **Step 1: Teste que falha**

`server/src/simulator/mjpeg.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MjpegParser } from './mjpeg.js';

const part = (data: Buffer) =>
  Buffer.concat([Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`), data, Buffer.from('\r\n')]);

const jpegA = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const jpegB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9, 9, 0xff, 0xd9]);

describe('MjpegParser', () => {
  it('frame inteiro em um chunk', () => {
    const p = new MjpegParser();
    expect(p.push(part(jpegA))).toEqual([jpegA]);
  });

  it('frame partido em vários chunks', () => {
    const p = new MjpegParser();
    const whole = part(jpegA);
    expect(p.push(whole.subarray(0, 10))).toEqual([]);
    expect(p.push(whole.subarray(10, 60))).toEqual([]);
    expect(p.push(whole.subarray(60))).toEqual([jpegA]);
  });

  it('dois frames no mesmo chunk', () => {
    const p = new MjpegParser();
    expect(p.push(Buffer.concat([part(jpegA), part(jpegB)]))).toEqual([jpegA, jpegB]);
  });

  it('cabeçalho sem Content-Length é descartado sem travar o próximo frame', () => {
    const p = new MjpegParser();
    const bad = Buffer.from('--BoundaryString\r\nContent-type: image/jpeg\r\n\r\n');
    expect(p.push(Buffer.concat([bad, part(jpegB)]))).toEqual([jpegB]);
  });

  it('frames devolvidos são cópias independentes do buffer interno', () => {
    const p = new MjpegParser();
    const [f] = p.push(part(jpegA));
    p.push(part(jpegB));
    expect(f).toEqual(jpegA);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/mjpeg.test.ts`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar**

`server/src/simulator/mjpeg.ts`:

```ts
const HEADER_END = Buffer.from('\r\n\r\n');
/** Limite de segurança: se acumular isso sem achar um cabeçalho, o stream está corrompido. */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Parser do multipart/x-mixed-replace que o WDA emite:
 * `--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>\r\n`.
 * Sem dependências; funciona com chunks de qualquer tamanho.
 */
export class MjpegParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf(HEADER_END);
      if (headerEnd === -1) {
        if (this.buf.length > MAX_BUFFER) this.buf = Buffer.alloc(0);
        break;
      }
      const header = this.buf.subarray(0, headerEnd).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(header);
      const start = headerEnd + HEADER_END.length;
      if (!m) {
        // Parte sem tamanho: pula o cabeçalho e segue procurando o próximo.
        this.buf = this.buf.subarray(start);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < start + len) break;
      frames.push(Buffer.from(this.buf.subarray(start, start + len)));
      this.buf = this.buf.subarray(start + len);
    }
    if (frames.length && this.buf.length === 0) this.buf = Buffer.alloc(0);
    return frames;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/mjpeg.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/simulator/mjpeg.ts server/src/simulator/mjpeg.test.ts
git commit -m "Simulador: parser do stream MJPEG do WDA

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `actions.ts` (tap/drag → W3C) e `keys.ts` (teclas especiais)

**Files:**
- Create: `server/src/simulator/actions.ts`, `server/src/simulator/actions.test.ts`, `server/src/simulator/keys.ts`, `server/src/simulator/keys.test.ts`

**Interfaces:**
- Produces:
  - `interface Point { x: number; y: number }`, `interface TimedPoint extends Point { t: number }`
  - `interface W3CActions { actions: PointerSequence[] }` (formato aceito por `POST /session/:id/actions` do WDA)
  - `tapActions(p: Point): W3CActions`, `dragActions(points: TimedPoint[]): W3CActions`
  - `specialKeyToWda(name: string): string | null`, `SPECIAL_KEY_NAMES: readonly string[]`

- [ ] **Step 1: Testes que falham**

`server/src/simulator/actions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dragActions, tapActions } from './actions.js';

describe('tapActions', () => {
  it('move, pressiona, pausa 80ms e solta', () => {
    const a = tapActions({ x: 10.6, y: 20.4 });
    expect(a.actions).toHaveLength(1);
    const seq = a.actions[0];
    expect(seq.type).toBe('pointer');
    expect(seq.parameters).toEqual({ pointerType: 'touch' });
    expect(seq.actions).toEqual([
      { type: 'pointerMove', duration: 0, x: 11, y: 20 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 80 },
      { type: 'pointerUp', button: 0 },
    ]);
  });
});

describe('dragActions', () => {
  it('usa as diferenças de t como duração dos moves', () => {
    const a = dragActions([
      { x: 0, y: 0, t: 1000 },
      { x: 10, y: 50, t: 1016 },
      { x: 20, y: 120, t: 1040 },
    ]);
    expect(a.actions[0].actions).toEqual([
      { type: 'pointerMove', duration: 0, x: 0, y: 0 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 16, x: 10, y: 50 },
      { type: 'pointerMove', duration: 24, x: 20, y: 120 },
      { type: 'pointerUp', button: 0 },
    ]);
  });

  it('duração mínima 1ms e máxima 2000ms', () => {
    const a = dragActions([
      { x: 0, y: 0, t: 0 },
      { x: 1, y: 1, t: 0 },
      { x: 2, y: 2, t: 99999 },
    ]);
    const moves = a.actions[0].actions.filter((x) => x.type === 'pointerMove');
    expect(moves[1]).toMatchObject({ duration: 1 });
    expect(moves[2]).toMatchObject({ duration: 2000 });
  });

  it('com um ponto só vira tap', () => {
    expect(dragActions([{ x: 5, y: 5, t: 0 }])).toEqual(tapActions({ x: 5, y: 5 }));
  });

  it('sem pontos lança erro', () => {
    expect(() => dragActions([])).toThrow();
  });
});
```

`server/src/simulator/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SPECIAL_KEY_NAMES, specialKeyToWda } from './keys.js';

describe('specialKeyToWda', () => {
  it('mapeia as teclas de controle para os códigos W3C', () => {
    expect(specialKeyToWda('Enter')).toBe('');
    expect(specialKeyToWda('Backspace')).toBe('');
    expect(specialKeyToWda('Tab')).toBe('');
    expect(specialKeyToWda('Escape')).toBe('');
    expect(specialKeyToWda('Delete')).toBe('');
    expect(specialKeyToWda('ArrowLeft')).toBe('');
    expect(specialKeyToWda('ArrowUp')).toBe('');
    expect(specialKeyToWda('ArrowRight')).toBe('');
    expect(specialKeyToWda('ArrowDown')).toBe('');
  });

  it('desconhecida devolve null', () => {
    expect(specialKeyToWda('F5')).toBeNull();
    expect(specialKeyToWda('a')).toBeNull();
  });

  it('SPECIAL_KEY_NAMES lista exatamente as teclas mapeadas', () => {
    for (const n of SPECIAL_KEY_NAMES) expect(specialKeyToWda(n)).not.toBeNull();
    expect(SPECIAL_KEY_NAMES).toContain('Enter');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/actions.test.ts src/simulator/keys.test.ts`
Expected: FAIL, módulos não encontrados.

- [ ] **Step 3: Implementar**

`server/src/simulator/actions.ts`:

```ts
export interface Point {
  x: number;
  y: number;
}
export interface TimedPoint extends Point {
  /** timestamp em ms (qualquer origem; só as diferenças importam) */
  t: number;
}

export type PointerAction =
  | { type: 'pointerMove'; duration: number; x: number; y: number }
  | { type: 'pointerDown'; button: 0 }
  | { type: 'pointerUp'; button: 0 }
  | { type: 'pause'; duration: number };

export interface PointerSequence {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'touch' };
  actions: PointerAction[];
}

/** Corpo de `POST /session/:id/actions` (WebDriver W3C Actions). */
export interface W3CActions {
  actions: PointerSequence[];
}

const MIN_MOVE_MS = 1;
const MAX_MOVE_MS = 2000;

const seq = (actions: PointerAction[]): W3CActions => ({
  actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }],
});

const round = (n: number) => Math.round(n);

export function tapActions(p: Point): W3CActions {
  return seq([
    { type: 'pointerMove', duration: 0, x: round(p.x), y: round(p.y) },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 80 },
    { type: 'pointerUp', button: 0 },
  ]);
}

export function dragActions(points: TimedPoint[]): W3CActions {
  if (points.length === 0) throw new Error('drag sem pontos');
  if (points.length === 1) return tapActions(points[0]);
  const [first, ...rest] = points;
  const actions: PointerAction[] = [
    { type: 'pointerMove', duration: 0, x: round(first.x), y: round(first.y) },
    { type: 'pointerDown', button: 0 },
  ];
  let prev = first;
  for (const p of rest) {
    const duration = Math.min(MAX_MOVE_MS, Math.max(MIN_MOVE_MS, round(p.t - prev.t)));
    actions.push({ type: 'pointerMove', duration, x: round(p.x), y: round(p.y) });
    prev = p;
  }
  actions.push({ type: 'pointerUp', button: 0 });
  return seq(actions);
}
```

`server/src/simulator/keys.ts`:

```ts
/** Nome de tecla do navegador (KeyboardEvent.key) → código WebDriver aceito por `POST /wda/keys`. */
const SPECIAL: Record<string, string> = {
  Enter: '',
  Backspace: '',
  Tab: '',
  Escape: '',
  Delete: '',
  ArrowLeft: '',
  ArrowUp: '',
  ArrowRight: '',
  ArrowDown: '',
};

export const SPECIAL_KEY_NAMES: readonly string[] = Object.keys(SPECIAL);

export function specialKeyToWda(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(SPECIAL, name) ? SPECIAL[name] : null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/actions.test.ts src/simulator/keys.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/simulator/actions.ts server/src/simulator/actions.test.ts server/src/simulator/keys.ts server/src/simulator/keys.test.ts
git commit -m "Simulador: conversão de tap/drag em W3C actions e mapa de teclas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `WdaClient`

**Files:**
- Create: `server/src/simulator/wda-client.ts`, `server/src/simulator/wda-client.test.ts`

**Interfaces:**
- Consumes: `W3CActions` (Task 3)
- Produces:
  - `class WdaError extends Error { status: number }`
  - `class WdaClient { constructor(baseUrl: string, fetchFn?: typeof fetch); sessionId: string | null; status(): Promise<{ ready: boolean }>; createSession(): Promise<string>; deleteSession(): Promise<void>; setSettings(s: Record<string, unknown>): Promise<void>; windowSize(): Promise<{ width: number; height: number }>; orientation(): Promise<'portrait' | 'landscape'>; setOrientation(o: 'portrait' | 'landscape'): Promise<void>; actions(a: W3CActions): Promise<void>; keys(values: string[]): Promise<void>; pressButton(name: string): Promise<void>; screenshotPng(): Promise<Buffer> }`

- [ ] **Step 1: Teste que falha**

`server/src/simulator/wda-client.test.ts` — usa um `fetch` falso que grava as chamadas:

```ts
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

    await c.keys(['a', '']);
    expect(f.calls[5]).toMatchObject({ url: 'http://127.0.0.1:8100/session/S1/wda/keys', body: { value: ['a', ''] } });

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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/wda-client.test.ts`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar**

`server/src/simulator/wda-client.ts`:

```ts
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
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/wda-client.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/simulator/wda-client.ts server/src/simulator/wda-client.test.ts
git commit -m "Simulador: cliente HTTP do WebDriverAgent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: modelo de dados (`Tab.kind`, `Tab.simulatorUdid`, `tmuxSession` opcional)

**Files:**
- Modify: `server/prisma/schema.prisma:118-130`, `server/src/db/repositories/types.ts` (`Tab`, `mapTab`), `server/src/db/repositories/tabs.ts`, `server/src/terminal/pty-session.ts:33`, `server/src/terminal/ws.ts` (handleConnection), `server/src/routes/projects.ts:58,84`, `server/src/routes/tabs.ts:26`
- Create: `server/prisma/migrations/<timestamp>_simulator_tabs/migration.sql`

**Interfaces:**
- Produces:
  - `type TabKind = 'terminal' | 'simulator'`
  - `interface Tab { id; project_id; name; kind: TabKind; tmux_session: string | null; simulator_udid: string | null; position; created_at }`
  - `TabsRepository.create(projectId: string, name: string, opts?: { kind?: TabKind; simulator_udid?: string | null }): Promise<Tab>`
  - `TabsRepository.update(id: string, patch: { name?: string; simulator_udid?: string | null }): Promise<Tab | undefined>` (mantém `rename` chamando `update`)

- [ ] **Step 1: Schema Prisma**

Em `server/prisma/schema.prisma`, adicione o enum junto dos outros enums e altere o model `Tab`:

```prisma
enum TabKind {
  terminal
  simulator
}

model Tab {
  id            String   @id
  projectId     String   @map("project_id")
  name          String
  kind          TabKind  @default(terminal)
  tmuxSession   String?  @unique @map("tmux_session")
  simulatorUdid String?  @map("simulator_udid")
  position      Int      @default(0)
  createdAt     DateTime @default(now()) @map("created_at")
  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  tasks         Task[]

  @@index([projectId])
  @@map("tabs")
}
```

- [ ] **Step 2: Migration**

Com o Postgres de dev no ar (`docker compose up -d db`, `DATABASE_URL` do `.env`), gere:

```bash
cd /Volumes/Extra/projects/8020/termhub && npm run prisma:migrate -- --name simulator_tabs
```

Se não houver banco disponível, crie à mão `server/prisma/migrations/$(date +%Y%m%d%H%M%S)_simulator_tabs/migration.sql` com exatamente:

```sql
-- CreateEnum
CREATE TYPE "TabKind" AS ENUM ('terminal', 'simulator');

-- AlterTable
ALTER TABLE "tabs" ADD COLUMN     "kind" "TabKind" NOT NULL DEFAULT 'terminal',
ADD COLUMN     "simulator_udid" TEXT,
ALTER COLUMN "tmux_session" DROP NOT NULL;
```

Depois: `npm run prisma:generate`. A CI confere drift com `prisma migrate diff`, então o SQL precisa bater com o schema.

- [ ] **Step 3: Tipos e repositório**

`server/src/db/repositories/types.ts`: adicione `export type TabKind = 'terminal' | 'simulator';` ao lado de `TaskStatus`, e altere `Tab` e `mapTab`:

```ts
export interface Tab {
  id: string;
  project_id: string;
  name: string;
  kind: TabKind;
  tmux_session: string | null;
  simulator_udid: string | null;
  position: number;
  created_at: string;
}

export const mapTab = (t: PrismaTab): Tab => ({
  id: t.id,
  project_id: t.projectId,
  name: t.name,
  kind: t.kind,
  tmux_session: t.tmuxSession,
  simulator_udid: t.simulatorUdid,
  position: t.position,
  created_at: t.createdAt.toISOString(),
});
```

`server/src/db/repositories/tabs.ts`: substitua `create` e `rename` por:

```ts
  async create(projectId: string, name: string, opts: { kind?: TabKind; simulator_udid?: string | null } = {}): Promise<Tab> {
    const id = newId();
    const kind = opts.kind ?? 'terminal';
    const agg = await this.db.tab.aggregate({ where: { projectId }, _max: { position: true } });
    const t = await this.db.tab.create({
      data: {
        id,
        projectId,
        name,
        kind,
        tmuxSession: kind === 'terminal' ? `termhub-${projectId}-${id}` : null,
        simulatorUdid: kind === 'simulator' ? (opts.simulator_udid ?? null) : null,
        position: (agg._max.position ?? -1) + 1,
      },
    });
    return mapTab(t);
  }

  async update(id: string, patch: { name?: string; simulator_udid?: string | null }): Promise<Tab | undefined> {
    const data: { name?: string; simulatorUdid?: string | null } = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.simulator_udid !== undefined) data.simulatorUdid = patch.simulator_udid;
    const t = await this.db.tab.update({ where: { id }, data });
    return mapTab(t);
  }

  async rename(id: string, name: string): Promise<Tab | undefined> {
    return this.update(id, { name });
  }
```

Importe `TabKind` de `./types.js` no topo.

- [ ] **Step 4: Guardas onde `tmux_session` era obrigatório**

`server/src/terminal/pty-session.ts`, em `buildSpawn`, antes de `assertSessionName(tab.tmux_session)`:

```ts
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new Error('Tab não é um terminal');
  assertSessionName(tab.tmux_session);
```

`server/src/terminal/ws.ts`, no `upgrade`, logo após carregar `tab`/`project`/`machine`:

```ts
    if (tab.kind !== 'terminal') return rejectUpgrade(socket, 404, 'Not Found');
```

`server/src/routes/projects.ts`:
- linha 58 (delete do projeto): `.map((t) => killTmuxSession(machine, t.tmux_session))` → `.filter((t) => t.tmux_session).map((t) => killTmuxSession(machine, t.tmux_session!))`
- linha 84 (listagem): `alive: alive.has(t.tmux_session)` → `alive: !!t.tmux_session && alive.has(t.tmux_session)` (Task 10 refina para simuladores).

`server/src/routes/tabs.ts`, no DELETE: `if (machine) {` → `if (machine && tab.tmux_session) {` e dentro use `tab.tmux_session`.

- [ ] **Step 5: Verificar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run prisma:generate && npm run typecheck -w server && npm test -w server`
Expected: typecheck limpo, testes passando. Se o banco de dev estiver no ar, `npx prisma migrate status` em `server/` mostra a migration aplicada.

- [ ] **Step 6: Commit**

```bash
git add server/prisma server/src/db/repositories/types.ts server/src/db/repositories/tabs.ts server/src/terminal/pty-session.ts server/src/terminal/ws.ts server/src/routes/projects.ts server/src/routes/tabs.ts
git commit -m "Tabs: kind (terminal|simulator), simulator_udid e tmux_session opcional

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: comandos na máquina (`machine.ts`), detecção `wda` e setup do WDA (`setup.ts`)

**Files:**
- Modify: `server/src/terminal/machine-exec.ts:70-73` (DETECT_SCRIPT)
- Create: `server/src/simulator/machine.ts`, `server/src/simulator/machine.test.ts`, `server/src/simulator/setup.ts`, `server/src/simulator/setup.test.ts`

**Interfaces:**
- Consumes: `runOnMachine`, `killTmuxSession`, `shellQuote` (machine-exec), `wdaPorts`, `runnerSessionName` (Task 1)
- Produces (`machine.ts`):
  - `interface Simulator { udid: string; name: string; runtime: string; state: string }`
  - `parseSimctlList(json: string): Simulator[]` (puro)
  - `runScript(machine: Machine, script: string, timeoutMs?: number): Promise<ExecResult>`
  - `listSimulators(machine): Promise<Simulator[]>`, `bootSimulator(machine, udid): Promise<void>`, `runnerAlive(machine, udid): Promise<boolean>`, `startRunner(machine, udid, ports: WdaPorts): Promise<void>`, `stopRunner(machine, udid): Promise<void>`, `runnerTail(machine, udid, lines?: number): Promise<string[]>`
  - `WDA_DIR = '$HOME/.termhub/WebDriverAgent'`
- Produces (`setup.ts`):
  - `type WdaSetupState = { state: 'idle' | 'running' | 'ok' | 'failed'; tail: string[]; version: string | null }`
  - `wdaSetupScript(): string` (puro), `parseSetupOutput(stdout: string): WdaSetupState` (puro)
  - `startWdaSetup(machine): Promise<void>` (lança `conflict` se já rodando), `wdaSetupState(machine): Promise<WdaSetupState>`

- [ ] **Step 1: Detecção `wda`**

Em `server/src/terminal/machine-exec.ts`, troque a constante `DETECT_SCRIPT` por:

```ts
const WDA_RUNNER_APP = '$HOME/.termhub/WebDriverAgent/DerivedData/Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app';
const DETECT_SCRIPT = `echo OS:$(uname -s); for t in ${DETECT_TOOLS.join(' ')}; do command -v $t >/dev/null 2>&1 && echo CAP:$t; done; [ -d "${WDA_RUNNER_APP}" ] && echo CAP:wda; exit 0`;
```

- [ ] **Step 2: Testes que falham**

`server/src/simulator/machine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSimctlList } from './machine.js';

const sample = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [
      { udid: 'AAA', name: 'iPhone 16e', state: 'Booted', isAvailable: true },
      { udid: 'BBB', name: 'iPad mini', state: 'Shutdown', isAvailable: true },
      { udid: 'CCC', name: 'Quebrado', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [],
  },
});

describe('parseSimctlList', () => {
  it('extrai runtime legível, ignora indisponíveis e põe bootados primeiro', () => {
    expect(parseSimctlList(sample)).toEqual([
      { udid: 'AAA', name: 'iPhone 16e', runtime: 'iOS 26.3', state: 'Booted' },
      { udid: 'BBB', name: 'iPad mini', runtime: 'iOS 26.3', state: 'Shutdown' },
    ]);
  });

  it('JSON inválido devolve lista vazia', () => {
    expect(parseSimctlList('nope')).toEqual([]);
  });
});
```

`server/src/simulator/setup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSetupOutput, wdaSetupScript } from './setup.js';

describe('parseSetupOutput', () => {
  it('lê estado, versão e tail', () => {
    const out = 'STATE:ok\nVERSION:16.12.8\nTAIL:\nlinha 1\nlinha 2\n';
    expect(parseSetupOutput(out)).toEqual({ state: 'ok', version: '16.12.8', tail: ['linha 1', 'linha 2'] });
  });

  it('sem versão devolve null e sem tail devolve []', () => {
    expect(parseSetupOutput('STATE:idle\nVERSION:\nTAIL:\n')).toEqual({ state: 'idle', version: null, tail: [] });
  });

  it('estado desconhecido vira failed', () => {
    expect(parseSetupOutput('lixo').state).toBe('failed');
  });
});

describe('wdaSetupScript', () => {
  it('clona ou atualiza, compila sem assinatura e grava status', () => {
    const s = wdaSetupScript();
    expect(s).toContain('git clone --depth 1 https://github.com/appium/WebDriverAgent');
    expect(s).toContain('git -C "$HOME/.termhub/WebDriverAgent" pull --ff-only');
    expect(s).toContain("-destination 'generic/platform=iOS Simulator'");
    expect(s).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(s).toContain('wda-setup.status');
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/machine.test.ts src/simulator/setup.test.ts`
Expected: FAIL, módulos não encontrados.

- [ ] **Step 4: Implementar `machine.ts`**

```ts
import type { Machine } from '../db/repositories/types.js';
import { killTmuxSession, runOnMachine, shellQuote, type ExecResult } from '../terminal/machine-exec.js';
import { runnerSessionName, type WdaPorts } from './ports.js';

export const WDA_DIR = '$HOME/.termhub/WebDriverAgent';

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

const PATH_PREFIX = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';

/** Roda um script sh na máquina (local ou ssh) com o PATH de login. */
export function runScript(machine: Machine, script: string, timeoutMs = 15_000): Promise<ExecResult> {
  const full = PATH_PREFIX + script;
  return runOnMachine(machine, { file: '/bin/sh', args: ['-lc', full] }, full, timeoutMs);
}

/** `xcrun simctl list devices -j` → lista plana, só disponíveis, bootados primeiro. */
export function parseSimctlList(json: string): Simulator[] {
  let data: { devices?: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> };
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const out: Simulator[] = [];
  for (const [runtimeId, devices] of Object.entries(data.devices ?? {})) {
    // com.apple.CoreSimulator.SimRuntime.iOS-26-3 → iOS 26.3
    const short = runtimeId.replace(/^.*SimRuntime\./, '');
    const runtime = short.replace(/^([A-Za-z]+)-(\d+)-(\d+)$/, '$1 $2.$3').replace(/-/g, ' ');
    for (const d of devices) {
      if (d.isAvailable === false) continue;
      out.push({ udid: d.udid, name: d.name, runtime, state: d.state });
    }
  }
  const rank = (s: string) => (s === 'Booted' ? 0 : 1);
  return out.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

const UDID_RE = /^[A-Fa-f0-9-]{8,64}$/;
function assertUdid(udid: string): void {
  if (!UDID_RE.test(udid)) throw new Error(`UDID inválido: ${udid}`);
}

export async function listSimulators(machine: Machine): Promise<Simulator[]> {
  const r = await runScript(machine, 'xcrun simctl list devices -j');
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'falha ao listar simuladores');
  return parseSimctlList(r.stdout);
}

export async function bootSimulator(machine: Machine, udid: string): Promise<void> {
  assertUdid(udid);
  const r = await runScript(machine, `xcrun simctl boot ${udid} 2>&1 || true`, 60_000);
  const out = (r.stdout + r.stderr).toLowerCase();
  if (out.includes('unable to boot') || out.includes('invalid device')) throw new Error(`simctl boot falhou: ${(r.stdout + r.stderr).trim()}`);
}

export async function runnerAlive(machine: Machine, udid: string): Promise<boolean> {
  const name = runnerSessionName(udid);
  const r = await runScript(machine, `tmux has-session -t '=${name}' 2>/dev/null && echo yes || echo no`);
  return r.stdout.includes('yes');
}

export async function startRunner(machine: Machine, udid: string, ports: WdaPorts): Promise<void> {
  assertUdid(udid);
  const name = runnerSessionName(udid);
  const cmd =
    `cd ${WDA_DIR} && xcodebuild test-without-building -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner ` +
    `-destination id=${udid} -derivedDataPath DerivedData USE_PORT=${ports.wdaPort} MJPEG_SERVER_PORT=${ports.mjpegPort}`;
  const r = await runScript(machine, `tmux new-session -d -s ${name} ${shellQuote(cmd)}`);
  if (r.code !== 0 && !r.stderr.includes('duplicate session')) throw new Error(r.stderr.trim() || 'falha ao iniciar o runner do WDA');
}

export async function stopRunner(machine: Machine, udid: string): Promise<void> {
  await killTmuxSession(machine, runnerSessionName(udid));
}

export async function runnerTail(machine: Machine, udid: string, lines = 30): Promise<string[]> {
  const name = runnerSessionName(udid);
  const r = await runScript(machine, `tmux capture-pane -p -t '=${name}' 2>/dev/null | grep -v '^$' | tail -n ${lines}`);
  return r.stdout.split('\n').filter((l) => l.trim());
}
```

- [ ] **Step 5: Implementar `setup.ts`**

```ts
import type { Machine } from '../db/repositories/types.js';
import { conflict } from '../lib/errors.js';
import { runScript, WDA_DIR } from './machine.js';

export const WDA_SETUP_SESSION = 'termhub-wda-setup';

export interface WdaSetupState {
  state: 'idle' | 'running' | 'ok' | 'failed';
  tail: string[];
  version: string | null;
}

/** Script que roda dentro do tmux na máquina: clone/pull + build-for-testing, log e status em ~/.termhub. */
export function wdaSetupScript(): string {
  return [
    '#!/bin/sh',
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    'mkdir -p "$HOME/.termhub"',
    'rm -f "$HOME/.termhub/wda-setup.status"',
    '{',
    `  if [ -d "${WDA_DIR}/.git" ]; then git -C "${WDA_DIR}" pull --ff-only; else git clone --depth 1 https://github.com/appium/WebDriverAgent "${WDA_DIR}"; fi &&`,
    `  cd "${WDA_DIR}" &&`,
    "  xcodebuild build-for-testing -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination 'generic/platform=iOS Simulator' -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO",
    '} > "$HOME/.termhub/wda-setup.log" 2>&1',
    'echo $? > "$HOME/.termhub/wda-setup.status"',
    '',
  ].join('\n');
}

const STATE_SCRIPT = `
if tmux has-session -t '=${WDA_SETUP_SESSION}' 2>/dev/null; then echo STATE:running;
elif [ -f "$HOME/.termhub/wda-setup.status" ]; then
  if [ "$(cat "$HOME/.termhub/wda-setup.status")" = 0 ]; then echo STATE:ok; else echo STATE:failed; fi;
else echo STATE:idle; fi
echo VERSION:$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "${WDA_DIR}/package.json" 2>/dev/null | head -1)
echo TAIL:
tail -n 40 "$HOME/.termhub/wda-setup.log" 2>/dev/null
exit 0`;

export function parseSetupOutput(stdout: string): WdaSetupState {
  const lines = stdout.split('\n');
  let state: WdaSetupState['state'] = 'failed';
  let version: string | null = null;
  const tail: string[] = [];
  let inTail = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (inTail) {
      if (line.trim()) tail.push(line);
      continue;
    }
    if (line.startsWith('STATE:')) {
      const s = line.slice(6).trim();
      if (s === 'idle' || s === 'running' || s === 'ok' || s === 'failed') state = s;
    } else if (line.startsWith('VERSION:')) {
      version = line.slice(8).trim() || null;
    } else if (line.startsWith('TAIL:')) {
      inTail = true;
    }
  }
  return { state, tail, version };
}

export async function wdaSetupState(machine: Machine): Promise<WdaSetupState> {
  const r = await runScript(machine, STATE_SCRIPT);
  if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || 'máquina inacessível');
  return parseSetupOutput(r.stdout);
}

export async function startWdaSetup(machine: Machine): Promise<void> {
  const current = await wdaSetupState(machine);
  if (current.state === 'running') throw conflict('Preparação do WDA já está em andamento');
  // 1) grava o script; 2) roda em tmux para sobreviver a queda do SSH/servidor.
  const write = `mkdir -p "$HOME/.termhub" && cat > "$HOME/.termhub/wda-setup.sh" <<'TERMHUB_EOF'\n${wdaSetupScript()}TERMHUB_EOF\nchmod +x "$HOME/.termhub/wda-setup.sh"`;
  const w = await runScript(machine, write);
  if (w.code !== 0) throw new Error(w.stderr.trim() || 'falha ao gravar o script de setup');
  const s = await runScript(machine, `tmux new-session -d -s ${WDA_SETUP_SESSION} 'sh "$HOME/.termhub/wda-setup.sh"'`);
  if (s.code !== 0) throw new Error(s.stderr.trim() || 'falha ao iniciar o setup no tmux');
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/machine.test.ts src/simulator/setup.test.ts && npm run typecheck`
Expected: 6 passed, typecheck limpo.

- [ ] **Step 7: Commit**

```bash
git add server/src/terminal/machine-exec.ts server/src/simulator/machine.ts server/src/simulator/machine.test.ts server/src/simulator/setup.ts server/src/simulator/setup.test.ts
git commit -m "Simulador: comandos simctl/tmux na máquina, detecção wda e setup do WDA

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: túnel SSH (`tunnel.ts`) e leitor do MJPEG (`mjpeg-reader.ts`)

**Files:**
- Create: `server/src/simulator/tunnel.ts`, `server/src/simulator/tunnel.test.ts`, `server/src/simulator/mjpeg-reader.ts`

**Interfaces:**
- Consumes: `sshBaseArgs(machine, connectTimeout)` (machine-exec), `WdaPorts` (Task 1), `MjpegParser` (Task 2)
- Produces:
  - `interface Tunnel { wdaPort: number; mjpegPort: number; close(): void; onClose(cb: (err?: Error) => void): void }`
  - `findFreePort(): Promise<number>`
  - `openTunnel(machine: Machine, remote: WdaPorts): Promise<Tunnel>` — para `machine.type === 'local'` devolve as portas remotas e um `close` vazio.
  - `openMjpeg(port: number, onFrame: (f: Buffer) => void, onEnd: (err?: Error) => void): () => void` — abre `http://127.0.0.1:<port>/`, entrega frames, devolve função de fechar.

- [ ] **Step 1: Teste de `findFreePort` (falha)**

`server/src/simulator/tunnel.test.ts`:

```ts
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort, openTunnel } from './tunnel.js';

describe('findFreePort', () => {
  it('devolve uma porta que dá para escutar', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1024);
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
  });
});

describe('openTunnel local', () => {
  it('máquina local não abre ssh e devolve as portas remotas', async () => {
    const t = await openTunnel(
      { id: 'm', name: 'local', host: null, ssh_user: null, ssh_port: 22, type: 'local', os: null, capabilities: [], checked_at: null, created_at: '' },
      { wdaPort: 8101, mjpegPort: 9101 },
    );
    expect(t).toMatchObject({ wdaPort: 8101, mjpegPort: 9101 });
    t.close();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/tunnel.test.ts`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `tunnel.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { Machine } from '../db/repositories/types.js';
import { sshBaseArgs } from '../terminal/machine-exec.js';
import type { WdaPorts } from './ports.js';

export interface Tunnel {
  wdaPort: number;
  mjpegPort: number;
  close(): void;
  onClose(cb: (err?: Error) => void): void;
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('sem porta livre'))));
    });
  });
}

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 300;

/** Espera o ssh começar a aceitar conexões na porta local encaminhada. */
function waitListening(port: number, proc: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      err ? reject(err) : resolve();
    };
    proc.once('exit', (code) => finish(new Error(`ssh encerrou (código ${code}): ${stderr().trim()}`)));
    const attempt = () => {
      if (done) return;
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        finish();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > READY_TIMEOUT_MS) finish(new Error(`túnel ssh não ficou pronto: ${stderr().trim()}`));
        else setTimeout(attempt, READY_POLL_MS);
      });
    };
    attempt();
  });
}

export async function openTunnel(machine: Machine, remote: WdaPorts): Promise<Tunnel> {
  if (machine.type === 'local') {
    return { wdaPort: remote.wdaPort, mjpegPort: remote.mjpegPort, close() {}, onClose() {} };
  }
  const [lp, lm] = await Promise.all([findFreePort(), findFreePort()]);
  const args = [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...sshBaseArgs(machine, 10),
    '-L',
    `127.0.0.1:${lp}:127.0.0.1:${remote.wdaPort}`,
    '-L',
    `127.0.0.1:${lm}:127.0.0.1:${remote.mjpegPort}`,
  ];
  const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  let err = '';
  proc.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
  const closeCbs: ((e?: Error) => void)[] = [];
  let closed = false;
  proc.once('exit', (code) => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb(new Error(`túnel ssh caiu (código ${code}): ${err.trim()}`));
  });
  await waitListening(lp, proc, () => err);
  return {
    wdaPort: lp,
    mjpegPort: lm,
    close() {
      if (closed) return;
      closed = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* já morreu */
      }
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
  };
}
```

- [ ] **Step 4: Implementar `mjpeg-reader.ts`**

```ts
import http from 'node:http';
import { MjpegParser } from './mjpeg.js';

/**
 * Abre o stream MJPEG do WDA em 127.0.0.1:<port> (porta local do túnel) e entrega frames.
 * Devolve a função que fecha o stream. `onEnd` é chamado uma vez, com erro ou não.
 */
export function openMjpeg(port: number, onFrame: (frame: Buffer) => void, onEnd: (err?: Error) => void): () => void {
  const parser = new MjpegParser();
  let ended = false;
  const end = (err?: Error) => {
    if (ended) return;
    ended = true;
    onEnd(err);
  };
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 15_000 }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      end(new Error(`MJPEG respondeu ${res.statusCode}`));
      return;
    }
    res.on('data', (chunk: Buffer) => {
      for (const f of parser.push(chunk)) onFrame(f);
    });
    res.on('end', () => end());
    res.on('error', (e) => end(e));
  });
  req.on('timeout', () => req.destroy(new Error('MJPEG sem dados por 15s')));
  req.on('error', (e) => end(e));
  return () => {
    ended = true;
    req.destroy();
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/tunnel.test.ts && npm run typecheck`
Expected: 2 passed, typecheck limpo.

- [ ] **Step 6: Commit**

```bash
git add server/src/simulator/tunnel.ts server/src/simulator/tunnel.test.ts server/src/simulator/mjpeg-reader.ts
git commit -m "Simulador: túnel ssh -L até o WDA e leitor do stream MJPEG

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `SimulatorSessionManager`

**Files:**
- Create: `server/src/simulator/session-manager.ts`, `server/src/simulator/session-manager.test.ts`, `server/src/simulator/backend.ts`

**Interfaces:**
- Consumes: `WdaClient` (Task 4), `Tunnel`, `openTunnel`, `openMjpeg` (Task 7), `bootSimulator`, `runnerAlive`, `startRunner`, `stopRunner`, `runnerTail` (Task 6), `wdaPorts` (Task 1)
- Produces:
  - `interface Viewer { onFrame(frame: Buffer): void; onStatus(s: SimStatus): void; onScreen(s: Screen): void }`
  - `type SimStatus = { state: 'booting' | 'starting' | 'ready' | 'error'; message?: string; tail?: string[] }`
  - `interface Screen { width: number; height: number; orientation: 'portrait' | 'landscape' }`
  - `interface SimulatorBackend { boot(m, udid); runnerAlive(m, udid); startRunner(m, udid, ports); stopRunner(m, udid); runnerTail(m, udid); openTunnel(m, ports); createClient(baseUrl); openMjpeg(port, onFrame, onEnd) }` (assinaturas iguais às funções de origem; `createClient(baseUrl: string): WdaClient`)
  - `realBackend: SimulatorBackend` (em `backend.ts`)
  - `interface SessionHandle { client: WdaClient; readonly screen: Screen; setSettings(scale: number, quality: number): Promise<void>; refreshScreen(): Promise<Screen>; release(): void }`
  - `class SimulatorSessionManager { constructor(backend: SimulatorBackend, opts?: { idleMs?: number; readyTimeoutMs?: number; pollMs?: number; log?: (msg: string, meta?: object) => void }); acquire(machine: Machine, udid: string, viewer: Viewer): Promise<SessionHandle>; isReady(machineId: string, udid: string): boolean; getClient(machineId: string, udid: string): WdaClient | null; shutdownAll(): Promise<void> }`

- [ ] **Step 1: Teste que falha**

`server/src/simulator/session-manager.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import type { SimulatorBackend, Viewer } from './session-manager.js';
import { SimulatorSessionManager } from './session-manager.js';
import { WdaClient } from './wda-client.js';

const machine: Machine = { id: 'm1', name: 'mac', host: 'mac.local', ssh_user: 'u', ssh_port: 22, type: 'ssh', os: 'macos', capabilities: ['wda'], checked_at: null, created_at: '' };
const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';

function makeBackend(overrides: Partial<SimulatorBackend> = {}) {
  let frameCb: ((f: Buffer) => void) | null = null;
  let endCb: ((e?: Error) => void) | null = null;
  const tunnelClose = vi.fn();
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status });
    if (url.endsWith('/status')) return body({ value: { ready: true } });
    if (url.endsWith('/session') && init?.method === 'POST') return body({ sessionId: 'S1', value: {} });
    if (url.endsWith('/window/size')) return body({ value: { width: 390, height: 844 } });
    if (url.endsWith('/orientation')) return body({ value: 'PORTRAIT' });
    return body({ value: null });
  }) as unknown as typeof fetch;
  const backend: SimulatorBackend = {
    boot: vi.fn(async () => {}),
    runnerAlive: vi.fn(async () => false),
    startRunner: vi.fn(async () => {}),
    stopRunner: vi.fn(async () => {}),
    runnerTail: vi.fn(async () => ['linha do runner']),
    openTunnel: vi.fn(async (_m, ports) => ({ wdaPort: ports.wdaPort, mjpegPort: ports.mjpegPort, close: tunnelClose, onClose() {} })),
    createClient: vi.fn((baseUrl: string) => new WdaClient(baseUrl, fetchFn)),
    openMjpeg: vi.fn((_port, onFrame, onEnd) => {
      frameCb = onFrame;
      endCb = onEnd;
      return vi.fn();
    }),
    ...overrides,
  };
  return { backend, fetchFn, tunnelClose, emitFrame: (f: Buffer) => frameCb?.(f), endStream: (e?: Error) => endCb?.(e) };
}

function makeViewer(): Viewer & { frames: Buffer[]; statuses: string[]; screens: unknown[] } {
  const v = {
    frames: [] as Buffer[],
    statuses: [] as string[],
    screens: [] as unknown[],
    onFrame(f: Buffer) {
      v.frames.push(f);
    },
    onStatus(s: { state: string }) {
      v.statuses.push(s.state);
    },
    onScreen(s: unknown) {
      v.screens.push(s);
    },
  };
  return v;
}

describe('SimulatorSessionManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sobe runner, túnel, sessão WDA e entrega status/screen/frames', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 1000 });
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    expect(b.backend.boot).toHaveBeenCalledWith(machine, UDID);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready']);
    expect(v.screens[0]).toEqual({ width: 390, height: 844, orientation: 'portrait' });
    expect(h.client.sessionId).toBe('S1');
    b.emitFrame(Buffer.from('f1'));
    expect(v.frames).toEqual([Buffer.from('f1')]);
    expect(mgr.isReady('m1', UDID)).toBe(true);
  });

  it('runner já vivo não é iniciado de novo', async () => {
    const b = makeBackend({ runnerAlive: vi.fn(async () => true) });
    const mgr = new SimulatorSessionManager(b.backend);
    await mgr.acquire(machine, UDID, makeViewer());
    expect(b.backend.startRunner).not.toHaveBeenCalled();
  });

  it('segundo viewer compartilha a sessão e recebe os mesmos frames', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend);
    const v1 = makeViewer();
    const v2 = makeViewer();
    await mgr.acquire(machine, UDID, v1);
    await mgr.acquire(machine, UDID, v2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v2.statuses).toEqual(['ready']);
    b.emitFrame(Buffer.from('x'));
    expect(v1.frames).toHaveLength(1);
    expect(v2.frames).toHaveLength(1);
  });

  it('último release encerra tudo depois de idleMs, e um novo acquire cancela', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 5000 });
    const h = await mgr.acquire(machine, UDID, makeViewer());
    h.release();
    await vi.advanceTimersByTimeAsync(4000);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    // novo viewer dentro da janela cancela o encerramento
    const h2 = await mgr.acquire(machine, UDID, makeViewer());
    await vi.advanceTimersByTimeAsync(6000);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    h2.release();
    await vi.advanceTimersByTimeAsync(5001);
    expect(b.backend.stopRunner).toHaveBeenCalledWith(machine, UDID);
    expect(b.tunnelClose).toHaveBeenCalled();
    const del = (b.fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE');
    expect(String(del?.[0])).toContain('/session/S1');
    expect(mgr.isReady('m1', UDID)).toBe(false);
  });

  it('status nunca pronto → error com o tail do runner e sessão descartada', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ value: { ready: false } }))) as unknown as typeof fetch;
    const b = makeBackend({ createClient: (baseUrl) => new WdaClient(baseUrl, fetchFn) });
    const mgr = new SimulatorSessionManager(b.backend, { readyTimeoutMs: 3000, pollMs: 1000 });
    const v = makeViewer();
    const p = mgr.acquire(machine, UDID, v);
    const rejected = expect(p).rejects.toThrow(/não ficou pronto/);
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(v.statuses.at(-1)).toBe('error');
    expect(mgr.isReady('m1', UDID)).toBe(false);
    expect(b.backend.runnerTail).toHaveBeenCalled();
  });

  it('stream MJPEG caindo reabre túnel e stream sem recriar a sessão WDA', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    b.endStream(new Error('caiu'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(2);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready', 'starting', 'ready']);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/session-manager.test.ts`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `session-manager.ts`**

```ts
import type { Machine } from '../db/repositories/types.js';
import { wdaPorts, type WdaPorts } from './ports.js';
import type { Tunnel } from './tunnel.js';
import { WdaClient, type Orientation } from './wda-client.js';

export type SimStatus = { state: 'booting' | 'starting' | 'ready' | 'error'; message?: string; tail?: string[] };
export interface Screen {
  width: number;
  height: number;
  orientation: Orientation;
}

export interface Viewer {
  onFrame(frame: Buffer): void;
  onStatus(s: SimStatus): void;
  onScreen(s: Screen): void;
}

export interface SimulatorBackend {
  boot(machine: Machine, udid: string): Promise<void>;
  runnerAlive(machine: Machine, udid: string): Promise<boolean>;
  startRunner(machine: Machine, udid: string, ports: WdaPorts): Promise<void>;
  stopRunner(machine: Machine, udid: string): Promise<void>;
  runnerTail(machine: Machine, udid: string): Promise<string[]>;
  openTunnel(machine: Machine, ports: WdaPorts): Promise<Tunnel>;
  createClient(baseUrl: string): WdaClient;
  openMjpeg(port: number, onFrame: (f: Buffer) => void, onEnd: (err?: Error) => void): () => void;
}

export interface SessionHandle {
  client: WdaClient;
  readonly screen: Screen;
  setSettings(scale: number, quality: number): Promise<void>;
  refreshScreen(): Promise<Screen>;
  release(): void;
}

interface Options {
  idleMs?: number;
  readyTimeoutMs?: number;
  pollMs?: number;
  log?: (msg: string, meta?: object) => void;
}

const DEFAULT_SETTINGS = { mjpegServerFramerate: 30, mjpegScalingFactor: 50, mjpegServerScreenshotQuality: 40 };
const RECOVER_ATTEMPTS = 3;
const RECOVER_DELAY_MS = 2000;

interface Session {
  key: string;
  machine: Machine;
  udid: string;
  ports: WdaPorts;
  viewers: Set<Viewer>;
  starting: Promise<void> | null;
  ready: boolean;
  client: WdaClient | null;
  tunnel: Tunnel | null;
  closeMjpeg: (() => void) | null;
  screen: Screen;
  idleTimer: ReturnType<typeof setTimeout> | null;
  recovering: boolean;
  disposed: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uma sessão de WDA por máquina+udid, compartilhada entre viewers (refcount + ociosidade). */
export class SimulatorSessionManager {
  private sessions = new Map<string, Session>();
  private idleMs: number;
  private readyTimeoutMs: number;
  private pollMs: number;
  private log: (msg: string, meta?: object) => void;

  constructor(
    private backend: SimulatorBackend,
    opts: Options = {},
  ) {
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 90_000;
    this.pollMs = opts.pollMs ?? 1000;
    this.log = opts.log ?? (() => {});
  }

  private key(machineId: string, udid: string) {
    return `${machineId}:${udid.toUpperCase()}`;
  }

  isReady(machineId: string, udid: string): boolean {
    return this.sessions.get(this.key(machineId, udid))?.ready ?? false;
  }

  getClient(machineId: string, udid: string): WdaClient | null {
    const s = this.sessions.get(this.key(machineId, udid));
    return s?.ready ? s.client : null;
  }

  async acquire(machine: Machine, udid: string, viewer: Viewer): Promise<SessionHandle> {
    const key = this.key(machine.id, udid);
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        key,
        machine,
        udid,
        ports: wdaPorts(udid),
        viewers: new Set(),
        starting: null,
        ready: false,
        client: null,
        tunnel: null,
        closeMjpeg: null,
        screen: { width: 0, height: 0, orientation: 'portrait' },
        idleTimer: null,
        recovering: false,
        disposed: false,
      };
      this.sessions.set(key, s);
      s.starting = this.start(s).finally(() => (s!.starting = null));
    }
    s.viewers.add(viewer);
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
    if (s.starting) {
      try {
        await s.starting;
      } catch (err) {
        s.viewers.delete(viewer);
        throw err;
      }
    } else if (s.ready) {
      viewer.onStatus({ state: 'ready' });
      viewer.onScreen(s.screen);
    }
    const session = s;
    let released = false;
    return {
      client: session.client!,
      get screen() {
        return session.screen;
      },
      setSettings: async (scale, quality) => {
        await session.client!.setSettings({ mjpegServerFramerate: 30, mjpegScalingFactor: scale, mjpegServerScreenshotQuality: quality });
      },
      refreshScreen: async () => {
        const [size, orientation] = await Promise.all([session.client!.windowSize(), session.client!.orientation()]);
        session.screen = { ...size, orientation };
        this.broadcast(session, (v) => v.onScreen(session.screen));
        return session.screen;
      },
      release: () => {
        if (released) return;
        released = true;
        this.release(session, viewer);
      },
    };
  }

  private broadcast(s: Session, fn: (v: Viewer) => void) {
    for (const v of s.viewers) {
      try {
        fn(v);
      } catch {
        /* viewer quebrado não derruba os outros */
      }
    }
  }

  private async start(s: Session): Promise<void> {
    const meta = { machineId: s.machine.id, udid: s.udid, ...s.ports };
    try {
      this.broadcast(s, (v) => v.onStatus({ state: 'booting' }));
      await this.backend.boot(s.machine, s.udid);
      this.broadcast(s, (v) => v.onStatus({ state: 'starting' }));
      if (!(await this.backend.runnerAlive(s.machine, s.udid))) {
        this.log('iniciando runner do WDA', meta);
        await this.backend.startRunner(s.machine, s.udid, s.ports);
      }
      await this.connect(s);
      const client = s.client!;
      await client.createSession();
      await client.setSettings(DEFAULT_SETTINGS);
      const [size, orientation] = await Promise.all([client.windowSize(), client.orientation()]);
      s.screen = { ...size, orientation };
      this.openStream(s);
      s.ready = true;
      this.log('simulador pronto', meta);
      this.broadcast(s, (v) => {
        v.onStatus({ state: 'ready' });
        v.onScreen(s.screen);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let tail: string[] | undefined;
      try {
        tail = await this.backend.runnerTail(s.machine, s.udid);
      } catch {
        tail = undefined;
      }
      this.log('falha ao subir simulador: ' + message, meta);
      this.broadcast(s, (v) => v.onStatus({ state: 'error', message, tail }));
      await this.dispose(s, { stopRunner: false });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /** Abre o túnel e espera o /status do WDA ficar pronto. */
  private async connect(s: Session): Promise<void> {
    const tunnel = await this.backend.openTunnel(s.machine, s.ports);
    s.tunnel = tunnel;
    tunnel.onClose((err) => {
      if (s.tunnel !== tunnel || s.disposed) return;
      void this.recover(s, err);
    });
    s.client = this.backend.createClient(`http://127.0.0.1:${tunnel.wdaPort}`);
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      try {
        if ((await s.client.status()).ready) return;
      } catch {
        /* ainda subindo */
      }
      if (Date.now() >= deadline) throw new Error('WDA não ficou pronto a tempo');
      await sleep(this.pollMs);
    }
  }

  private openStream(s: Session) {
    const port = s.tunnel!.mjpegPort;
    const close = this.backend.openMjpeg(
      port,
      (frame) => this.broadcast(s, (v) => v.onFrame(frame)),
      (err) => {
        if (s.closeMjpeg !== close || s.disposed) return;
        void this.recover(s, err);
      },
    );
    s.closeMjpeg = close;
  }

  /** Túnel ou stream caiu: reabre até RECOVER_ATTEMPTS vezes mantendo a sessão WDA. */
  private async recover(s: Session, cause?: Error): Promise<void> {
    if (s.recovering || s.disposed) return;
    s.recovering = true;
    s.ready = false;
    const meta = { machineId: s.machine.id, udid: s.udid };
    this.log('túnel/stream caiu, tentando recuperar: ' + (cause?.message ?? ''), meta);
    this.broadcast(s, (v) => v.onStatus({ state: 'starting', message: 'Reconectando ao simulador…' }));
    const sessionId = s.client?.sessionId ?? null;
    for (let i = 1; i <= RECOVER_ATTEMPTS; i++) {
      try {
        s.closeMjpeg?.();
        s.closeMjpeg = null;
        s.tunnel?.close();
        s.tunnel = null;
        await this.connect(s);
        s.client!.sessionId = sessionId;
        this.openStream(s);
        s.ready = true;
        s.recovering = false;
        this.broadcast(s, (v) => v.onStatus({ state: 'ready' }));
        return;
      } catch (err) {
        this.log(`recuperação ${i}/${RECOVER_ATTEMPTS} falhou: ${err instanceof Error ? err.message : err}`, meta);
        await sleep(RECOVER_DELAY_MS);
      }
    }
    s.recovering = false;
    this.broadcast(s, (v) => v.onStatus({ state: 'error', message: 'Conexão com o simulador perdida' }));
    await this.dispose(s, { stopRunner: false });
  }

  private release(s: Session, viewer: Viewer) {
    s.viewers.delete(viewer);
    if (s.viewers.size > 0 || s.disposed) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.viewers.size === 0) void this.dispose(s, { stopRunner: true });
    }, this.idleMs);
  }

  private async dispose(s: Session, opts: { stopRunner: boolean }): Promise<void> {
    if (s.disposed) return;
    s.disposed = true;
    s.ready = false;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.sessions.delete(s.key);
    s.closeMjpeg?.();
    s.closeMjpeg = null;
    try {
      await s.client?.deleteSession();
    } catch {
      /* WDA pode já ter morrido */
    }
    s.tunnel?.close();
    s.tunnel = null;
    if (opts.stopRunner) {
      try {
        await this.backend.stopRunner(s.machine, s.udid);
      } catch {
        /* máquina offline */
      }
    }
    this.log('sessão do simulador encerrada', { machineId: s.machine.id, udid: s.udid, stopRunner: opts.stopRunner });
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.dispose(s, { stopRunner: false })));
  }
}
```

- [ ] **Step 4: Implementar `backend.ts`**

```ts
import { bootSimulator, runnerAlive, runnerTail, startRunner, stopRunner } from './machine.js';
import { openMjpeg } from './mjpeg-reader.js';
import type { SimulatorBackend } from './session-manager.js';
import { openTunnel } from './tunnel.js';
import { WdaClient } from './wda-client.js';

export const realBackend: SimulatorBackend = {
  boot: bootSimulator,
  runnerAlive,
  startRunner,
  stopRunner,
  runnerTail: (m, udid) => runnerTail(m, udid, 30),
  openTunnel,
  createClient: (baseUrl) => new WdaClient(baseUrl),
  openMjpeg,
};
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/session-manager.test.ts && npm run typecheck`
Expected: 6 passed, typecheck limpo. Se o teste de recuperação ficar instável por causa do `sleep` interno com fake timers, use `await vi.runAllTimersAsync()` no lugar de `advanceTimersByTimeAsync(3000)`.

- [ ] **Step 6: Commit**

```bash
git add server/src/simulator/session-manager.ts server/src/simulator/session-manager.test.ts server/src/simulator/backend.ts
git commit -m "Simulador: gerenciador de sessões WDA (refcount, ociosidade, recuperação)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: roteador de `upgrade` e WebSocket do simulador

**Files:**
- Create: `server/src/ws/router.ts`, `server/src/simulator/ws.ts`, `server/src/simulator/ws-messages.ts`, `server/src/simulator/ws-messages.test.ts`
- Modify: `server/src/terminal/ws.ts` (usa o roteador), `server/src/app.ts:24,128-137`

**Interfaces:**
- Consumes: `resolveUser`, `parseCookies`, `AuthContext` (auth), `SimulatorSessionManager`, `Viewer`, `SessionHandle` (Task 8), `tapActions`, `dragActions` (Task 3), `specialKeyToWda` (Task 3), `WdaError` (Task 4)
- Produces:
  - `ws/router.ts`: `interface UpgradeContext { req: IncomingMessage; socket: Duplex; head: Buffer; url: URL; params: string[]; user: User }`, `type UpgradeHandler = (ctx: UpgradeContext) => void | Promise<void>`, `createUpgradeRouter(server: HttpServer, deps: { auth: AuthContext }): { add(pattern: RegExp, handler: UpgradeHandler): void }`, `rejectUpgrade(socket, status, text)`
  - `terminal/ws.ts`: `registerTerminalWs(router, deps: { repos; log }): WebSocketServer` (substitui `attachTerminalWebSocket`)
  - `simulator/ws.ts`: `registerSimulatorWs(router, deps: { repos; manager: SimulatorSessionManager; log }): { wss: WebSocketServer; closeTab(tabId: string): void }`
  - `simulator/ws-messages.ts`: `clientMessageSchema` (zod) e `type ClientMessage`

- [ ] **Step 1: Roteador de upgrade**

`server/src/ws/router.ts` — move `rejectUpgrade` e `originAllowed` de `terminal/ws.ts` para cá, sem mudar a lógica:

```ts
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from '../config.js';
import { parseCookies, resolveUser, type AuthContext } from '../auth/index.js';
import type { User } from '../db/repositories/types.js';

export interface UpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
  params: string[];
  user: User;
}
export type UpgradeHandler = (ctx: UpgradeContext) => void | Promise<void>;

export function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Anti CSWSH: a origem do navegador precisa bater com o host servido ou o PUBLIC_URL. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes não-navegador (curl, wscat) — já protegidos pela auth
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const host = req.headers.host;
  if (host && o.host === host) return true;
  try {
    if (o.host === new URL(config.publicUrl).host) return true;
  } catch {
    /* ignore */
  }
  if (!config.isProd && (o.hostname === 'localhost' || o.hostname === '127.0.0.1')) return true;
  return false;
}

/** Um único listener de `upgrade`: casa o path, checa origem e auth, e delega ao handler. */
export function createUpgradeRouter(server: HttpServer, deps: { auth: AuthContext }) {
  const routes: { pattern: RegExp; handler: UpgradeHandler }[] = [];
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.map((r) => ({ r, m: url.pathname.match(r.pattern) })).find((x) => x.m);
    if (!route?.m) return rejectUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    let user: User | null = null;
    try {
      user = await resolveUser(deps.auth, { headers: req.headers, cookies: parseCookies(req.headers.cookie) });
    } catch {
      user = null;
    }
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
    try {
      await route.r.handler({ req, socket, head, url, params: route.m.slice(1), user });
    } catch {
      rejectUpgrade(socket, 500, 'Internal Server Error');
    }
  });
  return {
    add(pattern: RegExp, handler: UpgradeHandler) {
      routes.push({ pattern, handler });
    },
  };
}
```

Confira o tipo devolvido por `resolveUser` em `server/src/auth/index.ts`; se for outro nome que não `User`, use esse nome no `UpgradeContext`.

- [ ] **Step 2: Terminal passa a usar o roteador**

Em `server/src/terminal/ws.ts`: remova `rejectUpgrade`, `originAllowed`, os imports de `config`, `parseCookies`, `resolveUser`, `AuthContext`, `IncomingMessage`, `Duplex`, e substitua `attachTerminalWebSocket` por:

```ts
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';

interface Deps {
  repos: Repositories;
  log: FastifyBaseLogger;
}

export function registerTerminalWs(router: ReturnType<typeof createUpgradeRouter>, deps: Deps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const log = deps.log.child({ mod: 'ws' });

  router.add(/^\/ws\/tabs\/([a-z0-9]+)\/?$/, async ({ req, socket, head, url, params }) => {
    const tabId = params[0];
    const tab = await deps.repos.tabs.findById(tabId);
    const project = tab && (await deps.repos.projects.findById(tab.project_id));
    const machine = project && (await deps.repos.machines.findById(project.machine_id));
    if (!tab || !project || !machine) return rejectUpgrade(socket, 404, 'Not Found');
    if (tab.kind !== 'terminal') return rejectUpgrade(socket, 404, 'Not Found');

    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      handleConnection(ws, { tab, project, machine, cols, rows }, deps, log);
    });
  });

  // Heartbeat: derruba conexões mortas (sem ping do cliente) a cada 30s.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      w.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));
  return wss;
}
```

`handleConnection` continua igual; ajuste seu parâmetro `deps: Deps` (não usa mais `auth`).

- [ ] **Step 3: Schema das mensagens do cliente (teste primeiro)**

`server/src/simulator/ws-messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clientMessageSchema } from './ws-messages.js';

describe('clientMessageSchema', () => {
  it('aceita as mensagens válidas', () => {
    for (const m of [
      { type: 'tap', x: 1, y: 2 },
      { type: 'drag', points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 16 }] },
      { type: 'keys', text: 'olá' },
      { type: 'key', name: 'Enter' },
      { type: 'button', name: 'home' },
      { type: 'rotate', orientation: 'landscape' },
      { type: 'settings', scale: 25, quality: 30 },
      { type: 'pause' },
      { type: 'resume' },
      { type: 'ping' },
    ]) expect(clientMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });

  it('rejeita fora dos limites', () => {
    expect(clientMessageSchema.safeParse({ type: 'settings', scale: 5, quality: 30 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'button', name: 'power' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'keys', text: 'x'.repeat(5000) }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'drag', points: [] }).success).toBe(false);
  });
});
```

Run: `cd /Volumes/Extra/projects/8020/termhub/server && npx vitest run src/simulator/ws-messages.test.ts` → FAIL (módulo não encontrado).

`server/src/simulator/ws-messages.ts`:

```ts
import { z } from 'zod';

const coord = z.number().finite().min(-10_000).max(10_000);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: coord, y: coord }),
  z.object({ type: z.literal('drag'), points: z.array(z.object({ x: coord, y: coord, t: z.number().finite() })).min(1).max(500) }),
  z.object({ type: z.literal('keys'), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('key'), name: z.string().min(1).max(32) }),
  z.object({ type: z.literal('button'), name: z.enum(['home', 'lock', 'volumeUp', 'volumeDown']) }),
  z.object({ type: z.literal('rotate'), orientation: z.enum(['portrait', 'landscape']) }),
  z.object({ type: z.literal('settings'), scale: z.number().int().min(10).max(100), quality: z.number().int().min(1).max(100) }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
```

Run de novo → 2 passed.

- [ ] **Step 4: WebSocket do simulador**

`server/src/simulator/ws.ts`:

```ts
import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import { dragActions, tapActions } from './actions.js';
import { specialKeyToWda } from './keys.js';
import type { SessionHandle, SimulatorSessionManager, Viewer } from './session-manager.js';
import { WdaError } from './wda-client.js';
import { clientMessageSchema } from './ws-messages.js';

interface Deps {
  repos: Repositories;
  manager: SimulatorSessionManager;
  log: FastifyBaseLogger;
}

const MAX_BUFFERED = 1024 * 1024;
const BUTTON_NAME: Record<string, string> = { home: 'home', lock: 'lock', volumeUp: 'volumeUp', volumeDown: 'volumeDown' };

export function registerSimulatorWs(router: ReturnType<typeof createUpgradeRouter>, deps: Deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const log = deps.log.child({ mod: 'sim-ws' });
  const byTab = new Map<string, Set<WebSocket>>();

  router.add(/^\/ws\/sim\/([a-z0-9]+)\/?$/, async ({ req, socket, head, params }) => {
    const tab = await deps.repos.tabs.findById(params[0]);
    const project = tab && (await deps.repos.projects.findById(tab.project_id));
    const machine = project && (await deps.repos.machines.findById(project.machine_id));
    if (!tab || !project || !machine || tab.kind !== 'simulator') return rejectUpgrade(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const set = byTab.get(tab.id) ?? new Set<WebSocket>();
      set.add(ws);
      byTab.set(tab.id, set);
      ws.once('close', () => {
        set.delete(ws);
        if (set.size === 0) byTab.delete(tab.id);
      });
      void handleConnection(ws, tab, machine, deps, log);
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      w.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  return {
    wss,
    /** Fecha as conexões abertas da tab (ex.: trocou de aparelho); os clientes reconectam. */
    closeTab(tabId: string) {
      for (const ws of byTab.get(tabId) ?? []) ws.close(4100, 'tab changed');
    },
  };
}

async function handleConnection(ws: WebSocket, tab: Tab, machine: Parameters<SimulatorSessionManager['acquire']>[0], deps: Deps, log: FastifyBaseLogger) {
  const w = ws as WebSocket & { isAlive?: boolean };
  w.isAlive = true;
  ws.on('pong', () => (w.isAlive = true));
  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  if (!tab.simulator_udid) {
    send({ type: 'status', state: 'no_device' });
    ws.on('message', (raw, isBinary) => {
      if (!isBinary && String(raw) === '{"type":"ping"}') send({ type: 'pong' });
    });
    return;
  }
  const udid = tab.simulator_udid;

  // Controle de fluxo: guarda só o último frame; envia quando o buffer do socket tem espaço.
  let paused = false;
  let pending: Buffer | null = null;
  const flush = () => {
    if (!pending || paused || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return;
    ws.send(pending, { binary: true });
    pending = null;
  };
  const flushTimer = setInterval(flush, 100);

  const viewer: Viewer = {
    onFrame(frame) {
      pending = frame;
      flush();
    },
    onStatus(s) {
      send({ type: 'status', ...s });
    },
    onScreen(s) {
      send({ type: 'screen', ...s });
    },
  };

  let handle: SessionHandle | null = null;
  try {
    handle = await deps.manager.acquire(machine, udid, viewer);
  } catch (err) {
    clearInterval(flushTimer);
    log.warn({ tabId: tab.id, machineId: machine.id, udid, err: err instanceof Error ? err.message : err }, 'simulador não subiu');
    // status 'error' já foi enviado pelo manager
    return;
  }
  log.info({ tabId: tab.id, machineId: machine.id, udid }, 'simulador conectado');

  const toast = (message: string) => send({ type: 'toast', message });
  const run = (p: Promise<unknown>) =>
    p.catch((err) => toast(err instanceof WdaError ? `WDA: ${err.message}` : err instanceof Error ? err.message : 'Comando falhou'));

  ws.on('message', (raw, isBinary) => {
    if (isBinary || !handle) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const r = clientMessageSchema.safeParse(parsed);
    if (!r.success) return;
    const m = r.data;
    const { client } = handle;
    switch (m.type) {
      case 'ping':
        return send({ type: 'pong' });
      case 'pause':
        paused = true;
        return;
      case 'resume':
        paused = false;
        return flush();
      case 'tap':
        return void run(client.actions(tapActions(m)));
      case 'drag':
        return void run(client.actions(dragActions(m.points)));
      case 'keys':
        return void run(client.keys([...m.text]));
      case 'key': {
        const code = specialKeyToWda(m.name);
        if (code) void run(client.keys([code]));
        return;
      }
      case 'button':
        return void run(client.pressButton(BUTTON_NAME[m.name]));
      case 'rotate':
        return void run(client.setOrientation(m.orientation).then(() => handle!.refreshScreen()));
      case 'settings':
        return void run(handle.setSettings(m.scale, m.quality));
    }
  });

  const cleanup = () => {
    clearInterval(flushTimer);
    handle?.release();
    handle = null;
    log.info({ tabId: tab.id }, 'simulador desconectado');
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
```

- [ ] **Step 5: Ligar no `app.ts`**

Em `server/src/app.ts`, troque o import de `attachTerminalWebSocket` por:

```ts
import { registerTerminalWs } from './terminal/ws.js';
import { createUpgradeRouter } from './ws/router.js';
import { registerSimulatorWs } from './simulator/ws.js';
import { SimulatorSessionManager } from './simulator/session-manager.js';
import { realBackend } from './simulator/backend.js';
```

Antes do bloco `await fastify.register(async (api) => { ... }, { prefix: '/api' })` crie o manager (as rotas da Task 10 precisam dele):

```ts
  const simulators = new SimulatorSessionManager(realBackend, { log: (msg, meta) => fastify.log.info(meta ?? {}, msg) });
```

Substitua o trecho `// --- WebSocket dos terminais ---` por:

```ts
  // --- WebSockets (terminais e simulador) ---
  const upgrades = createUpgradeRouter(fastify.server, { auth });
  registerTerminalWs(upgrades, { repos, log: fastify.log });
  const simWs = registerSimulatorWs(upgrades, { repos, manager: simulators, log: fastify.log });
```

No `onClose` adicione `await simulators.shutdownAll();` antes de `closePrisma()`. Guarde `simWs` e `simulators` para a Task 10 (passe-os como terceiro argumento das rotas; até lá, mantenha `void simWs;` para o typecheck não reclamar de variável sem uso).

- [ ] **Step 6: Verificar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run typecheck -w server && npm test -w server`
Expected: limpo. Depois suba o servidor de dev (`npm run dev:server`) e confirme que um terminal existente ainda conecta (o WS de terminal passou pelo roteador novo).

- [ ] **Step 7: Commit**

```bash
git add server/src/ws/router.ts server/src/terminal/ws.ts server/src/simulator/ws.ts server/src/simulator/ws-messages.ts server/src/simulator/ws-messages.test.ts server/src/app.ts
git commit -m "WS: roteador único de upgrade; WebSocket do simulador com controle de fluxo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: rotas HTTP (simuladores, setup do WDA, tabs de simulador, screenshot)

**Files:**
- Modify: `server/src/routes/machines.ts`, `server/src/routes/projects.ts:20,65-94`, `server/src/routes/tabs.ts`, `server/src/app.ts` (passar deps às rotas)

**Interfaces:**
- Consumes: `listSimulators` (Task 6), `startWdaSetup`, `wdaSetupState` (Task 6), `SimulatorSessionManager.isReady/getClient` (Task 8), `registerSimulatorWs(...).closeTab` (Task 9), `TabsRepository.create/update` (Task 5)
- Produces (HTTP):
  - `GET /api/machines/:id/simulators` → `{ simulators: Simulator[] }`
  - `POST /api/machines/:id/simulator/setup` → `{ ok: true }` (409 se já rodando; 400 se a máquina não é macOS com xcodebuild)
  - `GET /api/machines/:id/simulator/setup` → `WdaSetupState`
  - `POST /api/projects/:id/tabs` body `{ name?, kind?: 'terminal' | 'simulator', simulator_udid? }`
  - `GET /api/projects/:id/tabs` → `alive` de tab simulador = sessão pronta
  - `PATCH /api/tabs/:id` body `{ name?, simulator_udid?: string | null }`
  - `GET /api/tabs/:id/simulator/screenshot` → PNG (`Content-Disposition: attachment`), 409 se a sessão não está pronta

- [ ] **Step 1: `machines.ts`**

Adicione os imports e as rotas:

```ts
import { listSimulators } from '../simulator/machine.js';
import { startWdaSetup, wdaSetupState } from '../simulator/setup.js';
```

Dentro de `machineRoutes`, após `/:id/status`:

```ts
  const requireMac = (m: { os: string | null; capabilities: string[] }) => {
    if (m.os !== 'macos' || !m.capabilities.includes('xcodebuild')) throw badRequest('Esta máquina não é um Mac com Xcode');
  };

  app.get('/:id/simulators', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    requireMac(machine);
    return { simulators: await listSimulators(machine) };
  });

  app.get('/:id/simulator/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    const state = await wdaSetupState(machine);
    if (state.state === 'ok' && !machine.capabilities.includes('wda')) {
      const status = await machineStatus(machine);
      if (status.online) await repos.machines.setDetected(id, status.os, status.capabilities);
    }
    return state;
  });

  app.post('/:id/simulator/setup', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const machine = await repos.machines.findById(id);
    if (!machine) throw notFound('Máquina não encontrada');
    requireMac(machine);
    await startWdaSetup(machine);
    return reply.code(202).send({ ok: true });
  });
```

- [ ] **Step 2: `projects.ts`**

Troque a assinatura para `export async function projectRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: SimulatorSessionManager })` (import `type { SimulatorSessionManager } from '../simulator/session-manager.js'`), e o `tabBody` por:

```ts
const tabBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(['terminal', 'simulator']).optional(),
  simulator_udid: z.string().regex(/^[A-Fa-f0-9-]{8,64}$/).optional(),
});
```

Na listagem `GET /:id/tabs`, só consulte o tmux se houver tab terminal, e calcule `alive` por tipo:

```ts
    const terminalTabs = tabs.filter((t) => t.kind === 'terminal');
    if (machine && terminalTabs.length > 0) {
      try {
        alive = await listTmuxSessions(machine);
        reachable = true;
      } catch {
        reachable = false;
      }
    } else {
      reachable = true;
    }
    return {
      reachable,
      tabs: tabs.map((t) => ({
        ...t,
        alive:
          t.kind === 'simulator'
            ? !!t.simulator_udid && !!machine && deps.simulators.isReady(machine.id, t.simulator_udid)
            : !!t.tmux_session && alive.has(t.tmux_session),
      })),
    };
```

No `POST /:id/tabs`:

```ts
    const body = tabBody.parse(request.body ?? {});
    const kind = body.kind ?? 'terminal';
    const existing = await repos.tabs.listByProject(id);
    const count = existing.filter((t) => t.kind === kind).length + 1;
    const name = body.name ?? (kind === 'simulator' ? `Simulador ${count}` : `Terminal ${count}`);
    if (kind === 'simulator') {
      const machine = await repos.machines.findById(project.machine_id);
      if (!machine?.capabilities.includes('wda')) throw badRequest('Prepare o WDA nesta máquina antes de abrir um simulador');
    }
    const tab = await repos.tabs.create(id, name, { kind, simulator_udid: body.simulator_udid ?? null });
    return reply.code(201).send({ tab: { ...tab, alive: false } });
```

- [ ] **Step 3: `tabs.ts`**

Assinatura: `export async function tabRoutes(app, repos, deps: { simulators: SimulatorSessionManager; closeSimulatorTab: (tabId: string) => void })`. Substitua o `renameBody` e o PATCH:

```ts
const patchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  simulator_udid: z.string().regex(/^[A-Fa-f0-9-]{8,64}$/).nullable().optional(),
});

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const tab = await repos.tabs.findById(id);
    if (!tab) throw notFound('Tab não encontrada');
    const body = patchBody.parse(request.body);
    if (body.simulator_udid !== undefined && tab.kind !== 'simulator') throw badRequest('Só tabs de simulador têm aparelho');
    const updated = await repos.tabs.update(id, body);
    if (body.simulator_udid !== undefined && body.simulator_udid !== tab.simulator_udid) deps.closeSimulatorTab(id);
    return { tab: updated };
  });

  app.get('/:id/simulator/screenshot', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const tab = await repos.tabs.findById(id);
    if (!tab || tab.kind !== 'simulator') throw notFound('Tab não encontrada');
    const project = await repos.projects.findById(tab.project_id);
    if (!project || !tab.simulator_udid) throw conflict('Simulador não está conectado');
    const client = deps.simulators.getClient(project.machine_id, tab.simulator_udid);
    if (!client) throw conflict('Simulador não está conectado');
    const png = await client.screenshotPng();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return reply
      .header('content-type', 'image/png')
      .header('content-disposition', `attachment; filename="simulador-${stamp}.png"`)
      .send(png);
  });
```

Importe `badRequest`, `conflict` de `../lib/errors.js` e o tipo do manager.

- [ ] **Step 4: `app.ts`**

Atualize os registros: `projectRoutes(a, repos, { simulators })` e `tabRoutes(a, repos, { simulators, closeSimulatorTab: (id) => simWs.closeTab(id) })`. Como `simWs` é criado depois do bloco `/api`, mova a criação do roteador de upgrade e os `register*Ws` para **antes** do `fastify.register(... { prefix: '/api' })` (o `fastify.server` já existe nesse ponto). Remova o `void simWs;` provisório.

- [ ] **Step 5: Verificar com curl**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run typecheck -w server && npm test -w server`, depois com o servidor de dev no ar e logado no navegador (copie o cookie `termhub_session` e o `termhub_csrf` do DevTools):

```bash
curl -s -b 'termhub_session=<cookie>' http://localhost:3000/api/machines/<id-do-mac-mini>/simulators | head -c 400
curl -s -b 'termhub_session=<cookie>' http://localhost:3000/api/machines/<id-do-mac-mini>/simulator/setup
```

Expected: lista com o iPhone 16e (`state: Booted` primeiro) e `{ state: 'idle' | 'ok', ... }`.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/machines.ts server/src/routes/projects.ts server/src/routes/tabs.ts server/src/app.ts
git commit -m "API: simuladores da máquina, setup do WDA, tabs de simulador e screenshot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: web — tipos, API e `SimulatorConnection`

**Files:**
- Modify: `web/src/lib/types.ts` (`Tab`, novos tipos), `web/src/lib/api.ts` (`machines`, `projects.createTab`, `tabs`)
- Create: `web/src/lib/simulator-connection.ts`

**Interfaces:**
- Produces (types):
  - `type TabKind = 'terminal' | 'simulator'`; `Tab` ganha `kind: TabKind; tmux_session: string | null; simulator_udid: string | null`
  - `interface Simulator { udid: string; name: string; runtime: string; state: string }`
  - `interface WdaSetupState { state: 'idle' | 'running' | 'ok' | 'failed'; tail: string[]; version: string | null }`
  - `interface Screen { width: number; height: number; orientation: 'portrait' | 'landscape' }`
- Produces (api):
  - `api.machines.simulators(id)`, `api.machines.wdaSetup(id)`, `api.machines.startWdaSetup(id)`
  - `api.projects.createTab(id, input?: { name?: string; kind?: TabKind; simulator_udid?: string })`
  - `api.tabs.update(id, input: { name?: string; simulator_udid?: string | null })`, `api.tabs.screenshotUrl(id): string`
- Produces (connection): `type SimState = 'connecting' | 'booting' | 'starting' | 'ready' | 'no_device' | 'error' | 'offline' | 'closed'`, `class SimulatorConnection { constructor(tabId, handlers: SimulatorHandlers); connect(); close(); retryNow(); send(msg: ClientMessage) }`

- [ ] **Step 1: Tipos**

Em `web/src/lib/types.ts`, substitua a interface `Tab` e adicione:

```ts
export type TabKind = 'terminal' | 'simulator';

export interface Tab {
  id: string;
  project_id: string;
  name: string;
  kind: TabKind;
  tmux_session: string | null;
  simulator_udid: string | null;
  position: number;
  created_at: string;
  alive: boolean;
}

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

export interface WdaSetupState {
  state: 'idle' | 'running' | 'ok' | 'failed';
  tail: string[];
  version: string | null;
}

export interface Screen {
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
}
```

- [ ] **Step 2: API**

Em `web/src/lib/api.ts`, importe `Simulator`, `TabKind`, `WdaSetupState` e adicione:

```ts
  // dentro de machines:
    simulators: (id: string) => request<{ simulators: Simulator[] }>('GET', `/machines/${id}/simulators`),
    wdaSetup: (id: string) => request<WdaSetupState>('GET', `/machines/${id}/simulator/setup`),
    startWdaSetup: (id: string) => request<{ ok: true }>('POST', `/machines/${id}/simulator/setup`, {}),
  // projects.createTab passa a ser:
    createTab: (id: string, input: { name?: string; kind?: TabKind; simulator_udid?: string } = {}) =>
      request<{ tab: Tab }>('POST', `/projects/${id}/tabs`, input),
  // dentro de tabs:
    update: (id: string, input: { name?: string; simulator_udid?: string | null }) => request<{ tab: Tab }>('PATCH', `/tabs/${id}`, input),
    screenshotUrl: (id: string) => `/api/tabs/${id}/simulator/screenshot`,
```

Mantenha `tabs.rename` e `tabs.remove` como estão. Procure usos de `createTab(project.id)` (em `TerminalsView.tsx`) — continuam válidos.

- [ ] **Step 3: Conexão**

`web/src/lib/simulator-connection.ts`:

```ts
import type { Screen } from './types';

export type SimState = 'connecting' | 'booting' | 'starting' | 'ready' | 'no_device' | 'error' | 'offline' | 'closed';

export type ClientMessage =
  | { type: 'tap'; x: number; y: number }
  | { type: 'drag'; points: { x: number; y: number; t: number }[] }
  | { type: 'keys'; text: string }
  | { type: 'key'; name: string }
  | { type: 'button'; name: 'home' | 'lock' | 'volumeUp' | 'volumeDown' }
  | { type: 'rotate'; orientation: 'portrait' | 'landscape' }
  | { type: 'settings'; scale: number; quality: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'ping' };

export interface SimulatorHandlers {
  onFrame: (frame: Blob) => void;
  onStatus: (state: SimState, message?: string, tail?: string[]) => void;
  onScreen: (screen: Screen) => void;
  onToast: (message: string) => void;
}

const MAX_ATTEMPTS = 8;
const BASE_DELAY = 500;
const MAX_DELAY = 15_000;

/** WS do simulador: binário = frame JPEG; texto = JSON de controle. Reconecta com backoff, exceto após `error`. */
export class SimulatorConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private halted = false; // recebeu 'error' do servidor: só reconecta no retryNow()
  state: SimState = 'connecting';

  constructor(
    private tabId: string,
    private handlers: SimulatorHandlers,
  ) {}

  private setState(s: SimState, message?: string, tail?: string[]) {
    this.state = s;
    this.handlers.onStatus(s, message, tail);
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/sim/${this.tabId}`);
    ws.binaryType = 'blob';
    this.ws = ws;
    this.setState('connecting');
    ws.onopen = () => {
      this.attempt = 0;
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof Blob) {
        this.handlers.onFrame(ev.data);
        return;
      }
      let msg: { type: string; state?: SimState; message?: string; tail?: string[]; width?: number; height?: number; orientation?: 'portrait' | 'landscape' };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'status' && msg.state) {
        if (msg.state === 'error') this.halted = true;
        this.setState(msg.state, msg.message, msg.tail);
      } else if (msg.type === 'screen' && msg.width && msg.height && msg.orientation) {
        this.handlers.onScreen({ width: msg.width, height: msg.height, orientation: msg.orientation });
      } else if (msg.type === 'toast' && msg.message) {
        this.handlers.onToast(msg.message);
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (this.halted) {
        this.setState('error');
        return;
      }
      if (ev.code === 1008 || ev.code === 4001) {
        this.setState('offline');
        return;
      }
      if (ev.code === 4100) {
        // servidor fechou porque a tab trocou de aparelho: reconecta já
        this.attempt = 0;
        this.open();
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private scheduleReconnect() {
    if (this.attempt >= MAX_ATTEMPTS) {
      this.setState('offline');
      return;
    }
    this.attempt += 1;
    const delay = Math.min(BASE_DELAY * 2 ** (this.attempt - 1), MAX_DELAY) * (0.7 + Math.random() * 0.6);
    this.timer = setTimeout(() => this.open(), delay);
  }

  retryNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.halted = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.open();
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
  }
}
```

- [ ] **Step 4: Verificar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run build -w web`
Expected: typecheck + build limpos (os componentes que usam `tab.tmux_session` como string vão reclamar: `TabBar.tsx` título e `TerminalsView.tsx` diálogo de fechar — ajuste com `t.tmux_session ?? ''` por enquanto; a Task 12 refaz esses trechos).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/types.ts web/src/lib/api.ts web/src/lib/simulator-connection.ts web/src/components/TabBar.tsx web/src/components/TerminalsView.tsx
git commit -m "Web: tipos e API do simulador, conexão WS com reconexão

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: web — `SimulatorView` e integração em `TabBar`/`TerminalsView`

**Files:**
- Create: `web/src/components/SimulatorView.tsx`
- Modify: `web/src/components/TabBar.tsx`, `web/src/components/TerminalsView.tsx`, `web/src/components/Terminal.tsx:44-52` (exportar `isAppShortcut`)

**Interfaces:**
- Consumes: `SimulatorConnection`, `SimState`, `ClientMessage` (Task 11), `api.machines.simulators`, `api.tabs.update`, `api.tabs.screenshotUrl` (Task 11)
- Produces:
  - `SimulatorView({ tab: Tab; machineId: string; active: boolean; onTabChange: (tab: Tab) => void; onConnected?: () => void })`
  - `TabBar` ganha props `onNewSimulator?: () => void` e `canSimulator: boolean`

- [ ] **Step 1: Exportar `isAppShortcut`**

Em `web/src/components/Terminal.tsx`, troque `function isAppShortcut` por `export function isAppShortcut`.

- [ ] **Step 2: `SimulatorView.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { SimulatorConnection, type SimState } from '../lib/simulator-connection';
import type { Screen, Simulator, Tab } from '../lib/types';
import { isAppShortcut } from './Terminal';

interface Props {
  tab: Tab;
  machineId: string;
  active: boolean;
  onTabChange: (tab: Tab) => void;
  onConnected?: () => void;
}

const STATE_LABEL: Record<SimState, string> = {
  connecting: 'Conectando…',
  booting: 'Ligando o simulador…',
  starting: 'Subindo o WebDriverAgent…',
  ready: 'Conectado',
  no_device: 'Escolha um simulador',
  error: 'Erro',
  offline: 'Offline',
  closed: 'Encerrado',
};

const QUALITY = {
  lan: { scale: 50, quality: 50, label: 'LAN' },
  remote: { scale: 25, quality: 30, label: 'Remoto' },
} as const;
type QualityKey = keyof typeof QUALITY;

const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);
const TAP_MAX_MS = 200;
const TAP_MAX_PX = 6;
const KEY_BATCH_MS = 50;

/** Seletor de aparelho (usado no estado vazio e na barra). */
function DevicePicker({ machineId, value, onPick }: { machineId: string; value: string | null; onPick: (udid: string) => void }) {
  const [list, setList] = useState<Simulator[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.machines
      .simulators(machineId)
      .then((r) => !cancelled && setList(r.simulators))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Erro ao listar simuladores'));
    return () => {
      cancelled = true;
    };
  }, [machineId]);
  if (error) return <span className="text-xs text-danger">{error}</span>;
  return (
    <select className="input h-7 max-w-[260px] py-0 text-xs" value={value ?? ''} onChange={(e) => e.target.value && onPick(e.target.value)} disabled={!list}>
      <option value="">{list ? 'Escolha um simulador…' : 'Carregando…'}</option>
      {list?.map((s) => (
        <option key={s.udid} value={s.udid}>
          {s.name} · {s.runtime}
          {s.state === 'Booted' ? ' · ligado' : ''}
        </option>
      ))}
    </select>
  );
}

export function SimulatorView({ tab, machineId, active, onTabChange, onConnected }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const connRef = useRef<SimulatorConnection | null>(null);
  const screenRef = useRef<Screen | null>(null);
  const [state, setState] = useState<SimState>('connecting');
  const [message, setMessage] = useState<string | undefined>();
  const [tail, setTail] = useState<string[] | undefined>();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [fps, setFps] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityKey>('lan');
  const frameCount = useRef(0);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Conexão: uma por tab+udid.
  useEffect(() => {
    if (!tab.simulator_udid) {
      setState('no_device');
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const conn = new SimulatorConnection(tab.id, {
      onFrame: (blob) => {
        frameCount.current += 1;
        void createImageBitmap(blob).then((bmp) => {
          if (!canvas || !ctx) return;
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
        });
      },
      onStatus: (s, m, t) => {
        setState(s);
        setMessage(m);
        setTail(t);
        if (s === 'ready') onConnectedRef.current?.();
      },
      onScreen: (s) => {
        screenRef.current = s;
        setScreen(s);
      },
      onToast: (m) => setToast(m),
    });
    connRef.current = conn;
    conn.connect();
    const fpsTimer = setInterval(() => {
      setFps(frameCount.current);
      frameCount.current = 0;
    }, 1000);
    return () => {
      clearInterval(fpsTimer);
      conn.close();
      connRef.current = null;
    };
  }, [tab.id, tab.simulator_udid]);

  // Aba escondida → pausa o stream.
  useEffect(() => {
    const conn = connRef.current;
    if (!conn) return;
    conn.send({ type: active && document.visibilityState === 'visible' ? 'resume' : 'pause' });
    const onVis = () => conn.send({ type: active && document.visibilityState === 'visible' ? 'resume' : 'pause' });
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [active, state]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const send = useCallback((msg: Parameters<SimulatorConnection['send']>[0]) => connRef.current?.send(msg), []);

  // Canvas px → pontos lógicos.
  const toPoint = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const scr = screenRef.current;
    if (!canvas || !scr) return null;
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * scr.width, y: ((e.clientY - r.top) / r.height) * scr.height };
  };

  // Mouse: tap curto ou drag amostrado.
  const gesture = useRef<{ points: { x: number; y: number; t: number }[]; last: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    canvasRef.current?.focus();
    const p = toPoint(e);
    if (!p) return;
    gesture.current = { points: [{ ...p, t: performance.now() }], last: performance.now() };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const g = gesture.current;
    if (!g) return;
    const now = performance.now();
    if (now - g.last < 16) return;
    const p = toPoint(e);
    if (!p) return;
    g.points.push({ ...p, t: now });
    g.last = now;
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = toPoint(e);
    if (p) g.points.push({ ...p, t: performance.now() });
    const first = g.points[0];
    const last = g.points[g.points.length - 1];
    const dist = Math.hypot(last.x - first.x, last.y - first.y);
    if (last.t - first.t < TAP_MAX_MS && dist < TAP_MAX_PX) send({ type: 'tap', x: first.x, y: first.y });
    else send({ type: 'drag', points: g.points });
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toPoint(e);
    if (!p) return;
    e.preventDefault();
    const dy = Math.max(-200, Math.min(200, -e.deltaY));
    const t = performance.now();
    send({ type: 'drag', points: [{ x: p.x, y: p.y, t }, { x: p.x, y: p.y + dy / 2, t: t + 40 }, { x: p.x, y: p.y + dy, t: t + 80 }] });
  };

  // Teclado: caracteres em lote, especiais na hora.
  const keyBatch = useRef('');
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushKeys = useCallback(() => {
    keyTimer.current = null;
    if (keyBatch.current) send({ type: 'keys', text: keyBatch.current });
    keyBatch.current = '';
  }, [send]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isAppShortcut(e.nativeEvent)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      flushKeys();
      send({ type: 'key', name: e.key });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      keyBatch.current += e.key;
      if (!keyTimer.current) keyTimer.current = setTimeout(flushKeys, KEY_BATCH_MS);
    }
  };

  const pickDevice = async (udid: string) => {
    try {
      const { tab: updated } = await api.tabs.update(tab.id, { simulator_udid: udid });
      onTabChange(updated);
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Erro ao trocar de simulador');
    }
  };

  const changeQuality = (q: QualityKey) => {
    setQuality(q);
    send({ type: 'settings', scale: QUALITY[q].scale, quality: QUALITY[q].quality });
  };

  const ready = state === 'ready';
  const portrait = !screen || screen.orientation === 'portrait';
  const aspect = screen ? `${screen.width} / ${screen.height}` : portrait ? '9 / 19.5' : '19.5 / 9';

  return (
    <div className={`absolute inset-0 flex flex-col ${active ? '' : 'hidden'}`}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-bg-2 px-2 text-xs">
        <DevicePicker machineId={machineId} value={tab.simulator_udid} onPick={(u) => void pickDevice(u)} />
        <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-ok' : state === 'error' || state === 'offline' ? 'bg-danger' : 'bg-warn'}`} />
        <span className="text-fg-muted">{STATE_LABEL[state]}</span>
        {ready && <span className="text-fg-dim">{fps} fps</span>}
        <span className="ml-auto flex items-center gap-1">
          <button className="btn-ghost px-2 py-0.5" disabled={!ready} onClick={() => send({ type: 'button', name: 'home' })} title="Home">
            Home
          </button>
          <button className="btn-ghost px-2 py-0.5" disabled={!ready} onClick={() => send({ type: 'button', name: 'lock' })} title="Bloquear">
            Bloquear
          </button>
          <button className="btn-ghost px-2 py-0.5" disabled={!ready} onClick={() => send({ type: 'rotate', orientation: portrait ? 'landscape' : 'portrait' })} title="Girar">
            Girar
          </button>
          <a className={`btn-ghost px-2 py-0.5 ${ready ? '' : 'pointer-events-none opacity-50'}`} href={api.tabs.screenshotUrl(tab.id)} download title="Baixar screenshot PNG">
            Screenshot
          </a>
          <select className="input h-7 py-0 text-xs" value={quality} onChange={(e) => changeQuality(e.target.value as QualityKey)} disabled={!ready} title="Qualidade do stream">
            {(Object.keys(QUALITY) as QualityKey[]).map((k) => (
              <option key={k} value={k}>
                {QUALITY[k].label}
              </option>
            ))}
          </select>
          {(state === 'error' || state === 'offline' || state === 'closed') && (
            <button className="btn-primary px-2 py-0.5" onClick={() => connRef.current?.retryNow()}>
              Reconectar
            </button>
          )}
        </span>
      </div>
      {toast && <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">{toast}</div>}
      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-3">
        {!tab.simulator_udid ? (
          <div className="flex flex-col items-center gap-2 text-sm text-fg-muted">
            <p>Esta aba ainda não tem um simulador.</p>
            <DevicePicker machineId={machineId} value={null} onPick={(u) => void pickDevice(u)} />
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              tabIndex={0}
              className="max-h-full max-w-full rounded-lg outline-none ring-accent focus:ring-1"
              style={{ aspectRatio: aspect, height: portrait ? '100%' : undefined, width: portrait ? undefined : '100%' }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
              onContextMenu={(e) => e.preventDefault()}
            />
            {!ready && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-fg-muted">
                <p>{STATE_LABEL[state]}</p>
                {message && <p className="text-xs text-danger">{message}</p>}
                {tail && tail.length > 0 && (
                  <pre className="max-h-48 max-w-[90%] overflow-auto rounded bg-bg-2 p-2 text-[10px] text-fg-dim">{tail.join('\n')}</pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

Observações para quem implementa: as classes `btn-ghost`, `btn-primary`, `input`, `bg-bg-2`, `text-fg-muted`, `bg-ok`, `bg-warn`, `bg-danger`, `border-line` já existem em `web/src/index.css`/config do Tailwind (veja `TabBar.tsx` e `TerminalsView.tsx`). Se `createImageBitmap` não existir no browser alvo, troque por `new Image()` com `URL.createObjectURL(blob)` e `URL.revokeObjectURL` no `onload`.

- [ ] **Step 3: `TabBar.tsx`**

Adicione às props `onNewSimulator?: () => void; canSimulator: boolean;` e:
- no `title` da tab: `` `${t.name} — ${t.kind === 'simulator' ? 'simulador iOS' : t.tmux_session}${i < 9 ? `  (⌘${i + 1})` : ''}` ``
- no `title` da bolinha: `t.kind === 'simulator' ? (t.alive ? 'simulador conectado' : 'simulador desconectado') : t.alive ? 'sessão tmux ativa' : 'sessão tmux não iniciada'`
- antes do `<span className="truncate">{t.name}</span>` renderize `{t.kind === 'simulator' && <span className="text-[10px]" aria-hidden>📱</span>}`
- depois do botão `+`, renderize:

```tsx
      {canSimulator && (
        <button className="px-2 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onNewSimulator} title="Novo simulador iOS" aria-label="Novo simulador iOS">
          📱
        </button>
      )}
```

- [ ] **Step 4: `TerminalsView.tsx`**

- Importe `SimulatorView` e `TabKind`.
- `newTab` passa a aceitar o tipo: `const newTab = useCallback(async (kind: TabKind = 'terminal') => { ... await api.projects.createTab(project.id, { kind }); ... }, [project.id]);`. Nos atalhos e no estado vazio continue chamando `newTab()`.
- `canSimulator`: `const canSimulator = !!machine?.capabilities.includes('wda');`
- `<TabBar ... onNew={() => void newTab()} onNewSimulator={() => void newTab('simulator')} canSimulator={canSimulator} />`
- Renderização das tabs:

```tsx
          tabs.map((t) =>
            t.kind === 'simulator' ? (
              <SimulatorView
                key={t.id}
                tab={t}
                machineId={project.machine_id}
                active={visible && t.id === activeId}
                onTabChange={(updated) => setTabs((list) => (list ?? []).map((x) => (x.id === updated.id ? { ...updated, alive: x.alive } : x)))}
                onConnected={() => markAlive(t.id)}
              />
            ) : (
              <TerminalView key={t.id} tabId={t.id} active={visible && t.id === activeId} onConnected={() => markAlive(t.id)} />
            ),
          )
```

- Diálogo de fechar, mensagem por tipo:

```tsx
        message={
          closing?.kind === 'simulator' ? (
            <>
              Fechar <strong>{closing?.name}</strong>? O simulador continua ligado na máquina; só a aba é removida.
            </>
          ) : (
            <>
              Fechar <strong>{closing?.name}</strong>? A sessão tmux <code className="font-mono text-xs">{closing?.tmux_session}</code> será
              encerrada na máquina e o que estiver rodando nela será interrompido.
            </>
          )
        }
```

- [ ] **Step 5: Verificar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run build -w web`
Expected: limpo. Com `npm run dev` no ar, no projeto do Mac mini: o botão 📱 aparece se a máquina tem `wda`; criar a aba mostra "Esta aba ainda não tem um simulador" com o seletor.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SimulatorView.tsx web/src/components/TabBar.tsx web/src/components/TerminalsView.tsx web/src/components/Terminal.tsx
git commit -m "Web: aba de simulador iOS (canvas, toque, teclado, botões, seletor de aparelho)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: web — bloco "Simulador iOS" na edição da máquina

**Files:**
- Create: `web/src/components/SimulatorSetupCard.tsx`
- Modify: `web/src/components/MachineForm.tsx` (renderiza o card quando `machine` existe)

**Interfaces:**
- Consumes: `api.machines.wdaSetup`, `api.machines.startWdaSetup` (Task 11), `useData().checkStatus`
- Produces: `SimulatorSetupCard({ machine: Machine })`

- [ ] **Step 1: Componente**

`web/src/components/SimulatorSetupCard.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import type { Machine, WdaSetupState } from '../lib/types';

const POLL_MS = 3000;

export function SimulatorSetupCard({ machine }: { machine: Machine }) {
  const { checkStatus } = useData();
  const [setup, setSetup] = useState<WdaSetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isMac = machine.os === 'macos' && machine.capabilities.includes('xcodebuild');
  const hasWda = machine.capabilities.includes('wda');

  useEffect(() => {
    if (!isMac) return;
    let cancelled = false;
    const load = async () => {
      try {
        const s = await api.machines.wdaSetup(machine.id);
        if (cancelled) return;
        setSetup(s);
        setError(null);
        if (s.state === 'running') timer.current = setTimeout(load, POLL_MS);
        else if (s.state === 'ok' && !hasWda) void checkStatus(machine.id);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Erro ao consultar o setup');
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [machine.id, isMac, hasWda, checkStatus]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.machines.startWdaSetup(machine.id);
      setSetup({ state: 'running', tail: [], version: setup?.version ?? null });
      timer.current = setTimeout(async () => {
        try {
          const s = await api.machines.wdaSetup(machine.id);
          setSetup(s);
          if (s.state === 'running') timer.current = setTimeout(() => setSetup((cur) => cur && { ...cur }), POLL_MS);
        } catch {
          /* próximo poll tenta de novo */
        }
      }, POLL_MS);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao iniciar o setup');
    } finally {
      setBusy(false);
    }
  };

  if (!isMac) {
    return (
      <div className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
        <p className="mb-0.5 font-medium text-fg-muted">Simulador iOS</p>
        <p>Indisponível: precisa ser um Mac com Xcode instalado (detectado no status da máquina).</p>
      </div>
    );
  }

  const state = setup?.state ?? (hasWda ? 'ok' : 'idle');
  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium text-fg-muted">Simulador iOS</p>
        <span className="text-fg-dim">
          {state === 'running' && 'preparando…'}
          {state === 'ok' && `pronto${setup?.version ? ` · WDA ${setup.version}` : ''}`}
          {state === 'failed' && <span className="text-danger">falhou</span>}
          {state === 'idle' && 'não preparado'}
        </span>
        <button type="button" className="btn-ghost ml-auto px-2 py-0.5" onClick={() => void start()} disabled={busy || state === 'running'}>
          {state === 'ok' ? 'Atualizar' : state === 'failed' ? 'Tentar de novo' : 'Preparar'}
        </button>
      </div>
      <p className="mt-1 text-fg-dim">
        Clona e compila o WebDriverAgent em <code className="font-mono">~/.termhub/WebDriverAgent</code> (leva alguns minutos na primeira vez).
      </p>
      {error && <p className="mt-1 text-danger">{error}</p>}
      {setup && setup.tail.length > 0 && (state === 'running' || state === 'failed') && (
        <pre className="mt-1 max-h-32 overflow-auto rounded bg-bg-2 p-1.5 font-mono text-[10px] text-fg-dim">{setup.tail.join('\n')}</pre>
      )}
    </div>
  );
}
```

Simplifique o polling se preferir: o `useEffect` já repõe o timer enquanto `state === 'running'`; a lógica dentro de `start` pode só chamar `setSetup({ state: 'running', ... })` e disparar um `load()` extraído para fora do effect com `useCallback`. O comportamento exigido é: poll a cada 3 s enquanto `running`, parar ao terminar, e ao virar `ok` chamar `checkStatus(machine.id)` para `wda` aparecer em `capabilities`.

- [ ] **Step 2: Renderizar no `MachineForm`**

Em `web/src/components/MachineForm.tsx`, importe `SimulatorSetupCard` e, logo antes de `{error && <p className="text-sm text-danger">{error}</p>}`, adicione:

```tsx
        {machine && <SimulatorSetupCard machine={machine} />}
```

O `machine` do prop vem da lista do `useData()`, então após `checkStatus` o card recebe as `capabilities` atualizadas.

- [ ] **Step 3: Verificar**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm run build -w web`
Expected: limpo. Com `npm run dev`, editar o Mac mini mostra o bloco com estado "não preparado" ou "pronto" (se o checkout já existir em `~/.termhub`).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/SimulatorSetupCard.tsx web/src/components/MachineForm.tsx
git commit -m "Web: bloco Simulador iOS na máquina (preparar/atualizar WDA com log)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: verificação manual no Mac mini e ajustes finais

**Files:**
- Modify: o que a verificação apontar; `docs/superpowers/specs/2026-09-17-ios-simulator-tab-design.md` (registrar desvios, se houver)

- [ ] **Step 1: Ambiente**

Suba o dev (`docker compose up -d db` + `npm run dev`), faça login, e confirme que o Mac mini (192.168.68.118, memória `mac-mini-machine`) está online com `xcodebuild` nas capabilities (clique na bolinha de status). O checkout de teste em `/Volumes/Extra/projects/8020/WebDriverAgent` não é usado: o termhub cria o seu em `~/.termhub/WebDriverAgent`.

- [ ] **Step 2: Roteiro**

Marque cada item conforme passa; anote o que falhou e corrija antes de seguir.

1. Editar a máquina → bloco "Simulador iOS" em "não preparado" → **Preparar** → log aparece e atualiza a cada 3 s → termina em "pronto · WDA 16.x" e `wda` entra nas capabilities (tooltip do nome da máquina na sidebar).
2. No projeto do Mac mini, botão 📱 aparece → criar aba → estado vazio com seletor → escolher o iPhone 16e (aparece "ligado").
3. Overlay passa por "Ligando…" → "Subindo o WebDriverAgent…" (até ~40 s na primeira vez) → imagem aparece, fps entre 15 e 27.
4. Tocar num ícone abre o app; arrastar rola uma lista; roda do mouse rola.
5. Clicar num campo de texto no simulador, digitar no canvas → texto aparece; Enter e Backspace funcionam.
6. Home, Bloquear (tela apaga; tocar/Home religa), Girar (canvas muda de proporção e a imagem acompanha).
7. Screenshot baixa um PNG em resolução cheia.
8. Trocar para "Remoto": fps mantém e o frame fica menor (DevTools → WS → tamanho das mensagens cai para ~50 KB).
9. Segunda aba de navegador com a mesma tab: as duas recebem frames; fechar uma não derruba a outra.
10. Trocar o aparelho no seletor da barra → WS reconecta e mostra o outro simulador (boot pode levar mais).
11. Fechar todas as visualizações → após 5 min `tmux ls` no Mac não tem mais `termhub-wda-…`; o simulador continua bootado (`xcrun simctl list devices booted`).
12. Reiniciar o servidor de dev com a aba aberta → a aba reconecta sozinha e a imagem volta (runner reaproveitado: `startRunner` não roda de novo, ver log).
13. Matar o runner na mão (`tmux kill-session -t termhub-wda-…`) com a aba aberta → overlay de erro com "Reconectar" → reconectar sobe o runner de novo.
14. Um terminal comum do mesmo projeto continua funcionando (regressão do roteador de upgrade).

- [ ] **Step 3: Testes e build completos**

Run: `cd /Volumes/Extra/projects/8020/termhub && npm test -w server && npm run typecheck -w server && npm run build -w web && npm run build -w server`
Expected: tudo limpo.

- [ ] **Step 4: Commit dos ajustes e registro**

Se o roteiro exigiu mudanças, commite-as com mensagens descritivas. Se algum comportamento ficou diferente da spec (ex.: fps real, teclas que o WDA não aceitou), atualize a seção correspondente da spec no mesmo commit.

```bash
git add -A docs server web
git commit -m "Simulador iOS: ajustes da verificação manual no Mac mini

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Auto-revisão do plano (feita ao escrever)

- **Cobertura da spec:** modelo de dados (T5); provisionamento (T6, T10, T13); ciclo de vida com boot, portas, runner em tmux, túnel, espera do status, settings, leitor único, ociosidade de 5 min, recuperação até 3 vezes (T7, T8); protocolo WS com controle de fluxo, pause/resume, toast (T9); cliente com canvas, tap/drag/roda, teclado em lote, barra com seletor/Home/Bloquear/Girar/Screenshot/qualidade/fps (T12); erros da tabela (T8 status `error` com tail, T12 overlay + Reconectar, T10 409/400); segurança (roteador reutiliza auth/origem, T9); testes listados na spec (T1–T4, T6, T8, T9) + CI (T1); roteiro manual (T14).
- **Desvio registrado:** teclas especiais via `key {name}` mapeadas no servidor (Global Constraints).
- **Consistência de nomes:** `wdaPorts`/`runnerSessionName` (T1) usados em T6/T8; `MjpegParser` (T2) em T7; `tapActions`/`dragActions`/`specialKeyToWda` (T3) em T9; `WdaClient` métodos (T4) em T8/T9/T10; `runScript`/`listSimulators`/`bootSimulator`/`runnerAlive`/`startRunner`/`stopRunner`/`runnerTail` (T6) em T8 `backend.ts` e T10; `openTunnel`/`openMjpeg` (T7) em T8; `SimulatorSessionManager.acquire/isReady/getClient/shutdownAll` (T8) em T9/T10; `registerSimulatorWs(...).closeTab` (T9) em T10; `api.tabs.update/screenshotUrl`, `api.machines.simulators/wdaSetup/startWdaSetup` (T11) em T12/T13.
