import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { publicId, publicRoomId } from './public-id.js';
import type { PublicCity } from './city.js';

// readPublicCity only ever reads the tmux memo (see public/read.ts); stub it the same way
// public-city.test.ts does so this file never depends on a real machine.
vi.mock('../terminal/machine-exec.js', () => ({
  probeTmuxSessionsCached: vi.fn(async () => {
    throw new Error('probeTmuxSessionsCached must never be called from a public read');
  }),
  cachedTmuxProbe: () => ({ reachable: true, sessions: new Set(['th-t1']) }),
}));

const { cityMetaFor, renderCityDocument, depthFromCityUrl, renderCityPage } = await import('./city-page.js');

const BASE = 'https://termhub.dev/city';

const TEMPLATE = `<!doctype html>
<html lang="pt-BR" class="dark">
  <head>
    <meta charset="UTF-8" />
    <title>termhub · cidade</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const CITY: PublicCity = {
  nickname: 'pedro',
  owner_name: 'Pedro',
  buildings: [
    {
      id: publicId('machine', 'm1'),
      name: 'Jarvis Office',
      rooms: [
        {
          id: publicRoomId('p1', 'm1'),
          name: 'Engage Easy',
          robots: [],
        },
        {
          id: publicRoomId('p2', 'm1'),
          name: 'A "melhor" ideia & cia',
          robots: [],
        },
      ],
    },
  ],
};

describe('cityMetaFor', () => {
  it('names the owner at the city depth, and the card at no depth', () => {
    const meta = cityMetaFor(CITY, {}, BASE);
    expect(meta.title).toBe('A cidade de Pedro no termhub');
    expect(meta.image).toBe('https://termhub.dev/api/public/city/pedro/card.png');
  });

  it('names the building at the building depth', () => {
    const meta = cityMetaFor(CITY, { building: CITY.buildings[0]!.id }, BASE);
    expect(meta.title).toBe('Jarvis Office — a cidade de Pedro');
    expect(meta.image).toBe(`https://termhub.dev/api/public/city/pedro/card.png?building=${CITY.buildings[0]!.id}`);
  });

  it('names the room at the room depth', () => {
    const building = CITY.buildings[0]!;
    const room = building.rooms[0]!;
    const meta = cityMetaFor(CITY, { building: building.id, room: room.id }, BASE);
    expect(meta.title).toBe('Engage Easy — a cidade de Pedro');
    expect(meta.image).toBe(`https://termhub.dev/api/public/city/pedro/card.png?building=${building.id}&room=${room.id}`);
  });

  it('falls back one level up when a depth id matches nothing in this city, same as buildCardSvg', () => {
    const meta = cityMetaFor(CITY, { building: 'does-not-exist' }, BASE);
    expect(meta.title).toBe('A cidade de Pedro no termhub');
  });

  it('answers the neutral, name-free document for no city at all', () => {
    const meta = cityMetaFor(undefined, {}, BASE);
    expect(meta.title).toBe('Cidade não encontrada · termhub');
    expect(meta.title).not.toContain('Pedro');
    expect(meta.image).toBe('https://termhub.dev/og-image.png');
  });
});

describe('renderCityDocument', () => {
  it('sets the title and the three og: tags', () => {
    const html = renderCityDocument(TEMPLATE, { title: 'A cidade de Pedro no termhub', description: 'desc', image: 'https://termhub.dev/api/public/city/pedro/card.png' });
    expect(html).toContain('<title>A cidade de Pedro no termhub</title>');
    expect(html).toContain('<meta property="og:title" content="A cidade de Pedro no termhub" />');
    expect(html).toContain('<meta property="og:description" content="desc" />');
    expect(html).toContain('<meta property="og:image" content="https://termhub.dev/api/public/city/pedro/card.png" />');
  });

  it('escapes a name carrying " and & so it cannot break out of the attribute', () => {
    const title = 'A "melhor" ideia & cia — a cidade de Pedro';
    const html = renderCityDocument(TEMPLATE, { title, description: 'A "melhor" ideia & cia', image: 'https://termhub.dev/x' });
    expect(html).toContain('content="A &quot;melhor&quot; ideia &amp; cia — a cidade de Pedro"');
    // the raw, unescaped title must never appear — that is the actual attribute break-out
    expect(html).not.toContain(`content="${title}"`);
  });
});

describe('depthFromCityUrl', () => {
  it('reads the nickname without its @, and no depth when the path carries none', () => {
    expect(depthFromCityUrl('/city/@pedro')).toEqual({ nickname: 'pedro', depth: { building: undefined, room: undefined } });
  });

  it('reads the building segment and the room query param', () => {
    expect(depthFromCityUrl('/city/@pedro/abc?room=xyz')).toEqual({ nickname: 'pedro', depth: { building: 'abc', room: 'xyz' } });
  });

  it('never throws on a malformed escape, and hands the raw segment on instead', () => {
    expect(() => depthFromCityUrl('/city/@pedro%/abc')).not.toThrow();
    expect(depthFromCityUrl('/city/@pedro%/abc').nickname).toBe('pedro%');
  });
});

function stubRepos(): Repositories {
  const machines = [{ id: 'm1', name: 'Jarvis Office', owner_id: 'u1' }];
  const projects = [
    { id: 'p1', owner_id: 'u1', name: 'Engage Easy', status: 'active', is_public: true },
    { id: 'p2', owner_id: 'u1', name: 'A "melhor" ideia & cia', status: 'active', is_public: true },
  ];
  const links = [
    { project_id: 'p1', machine_id: 'm1' },
    { project_id: 'p2', machine_id: 'm1' },
  ];
  const tabs = [
    { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'shell', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, state: 'working' },
    { id: 't2', project_id: 'p2', machine_id: 'm1', name: 'shell', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, state: 'working' },
  ];
  return {
    users: {
      findByNickname: vi.fn(async (nickname: string) => (nickname === 'pedro' ? { id: 'u1', name: 'Pedro' } : undefined)),
    },
    machines: { list: vi.fn(async (ownerId?: string | null) => machines.filter((m) => m.owner_id === ownerId)) },
    projects: { list: vi.fn(async ({ owner }: { owner: string }) => projects.filter((p) => p.owner_id === owner)) },
    projectMachines: { listByProjects: vi.fn(async (ids: string[]) => links.filter((l) => ids.includes(l.project_id))) },
    tabs: { listByProjectsOnMachine: vi.fn(async (ids: string[], machineId: string) => tabs.filter((t) => ids.includes(t.project_id) && t.machine_id === machineId)) },
  } as unknown as Repositories;
}

/** The document at `/city/*`, wired exactly the way `app.ts`'s SPA fallback wires it — the same function, over HTTP. */
function buildDocumentApp(repos: Repositories, base = BASE) {
  const app = Fastify();
  app.setNotFoundHandler(async (request, reply) => {
    const html = await renderCityPage(repos, TEMPLATE, request.url, base);
    return reply.type('text/html').send(html);
  });
  return app;
}

describe('GET /city/:nickname — the document', () => {
  it("names the owner in og:title and the nickname in og:image", async () => {
    const app = buildDocumentApp(stubRepos());
    const res = await app.inject({ method: 'GET', url: '/city/@pedro' });
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<meta property="og:title" content="A cidade de Pedro no termhub" />');
    expect(res.body).toContain('<meta property="og:image" content="https://termhub.dev/api/public/city/pedro/card.png" />');
  });

  it('escapes a room name carrying " and & at the room depth', async () => {
    const app = buildDocumentApp(stubRepos());
    const building = publicId('machine', 'm1');
    const room = publicRoomId('p2', 'm1');
    const res = await app.inject({ method: 'GET', url: `/city/@pedro/${building}?room=${room}` });
    expect(res.body).toContain('content="A &quot;melhor&quot; ideia &amp; cia — a cidade de Pedro"');
    expect(res.body).not.toContain('content="A "melhor" ideia & cia — a cidade de Pedro"');
  });

  it('answers the neutral, name-free document with the landing static card for an unknown nickname', async () => {
    const app = buildDocumentApp(stubRepos());
    const res = await app.inject({ method: 'GET', url: '/city/@ninguem' });
    expect(res.body).toContain('<title>Cidade não encontrada · termhub</title>');
    expect(res.body).not.toContain('Pedro');
    expect(res.body).toContain('<meta property="og:image" content="https://termhub.dev/og-image.png" />');
  });

  it('sets og:url to the canonical address of the depth the link points at', async () => {
    const app = buildDocumentApp(stubRepos());
    const building = publicId('machine', 'm1');
    const room = publicRoomId('p1', 'm1');
    const res = await app.inject({ method: 'GET', url: `/city/@pedro/${building}?room=${room}` });
    expect(res.body).toContain(`<meta property="og:url" content="https://termhub.dev/city/@pedro/${building}?room=${room}" />`);
  });

  // A self-hosted instance: every URL in the document is its own, never termhub.dev's.
  it('builds og:url, og:image and the fallback card from the instance\'s own base', async () => {
    const app = buildDocumentApp(stubRepos(), 'https://th.example.org/city');
    const found = await app.inject({ method: 'GET', url: '/city/@pedro' });
    expect(found.body).toContain('<meta property="og:url" content="https://th.example.org/city/@pedro" />');
    expect(found.body).toContain('<meta property="og:image" content="https://th.example.org/api/public/city/pedro/card.png" />');
    const missing = await app.inject({ method: 'GET', url: '/city/@ninguem' });
    expect(missing.body).toContain('<meta property="og:image" content="https://th.example.org/og-image.png" />');
    expect(found.body + missing.body).not.toContain('termhub.dev');
  });
});
