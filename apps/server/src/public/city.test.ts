import { describe, expect, it } from 'vitest';
import { toPublicCity, toPublicRobot, toPublicRobotFrame, toPublicRobotGone } from './city.js';
import { publicId } from './public-id.js';
import type { Project, Tab } from '../db/repositories/types.js';

const tab = (over: Partial<Tab> = {}): Tab => ({
  id: 't1', project_id: 'p1', machine_id: 'maquina-secreta-id', name: 'corrigir o cliente ACME', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null,
  created_by_token_id: null, position: 0, state: 'working', state_text: 'rodando os testes', state_tool: 'claude', state_at: '2026-09-22T10:00:00.000Z',
  state_seen_at: null, activity: 'coding', activity_verb: null, created_at: '2026-09-22T09:00:00.000Z', ...over,
});
const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', owner_id: 'u1', key: 'ENG', next_task_number: 1, name: 'Engage Easy', status: 'active', description: 'o que eu não quero na rua', is_public: true, public_id: 'not-emitted', last_terminal_at: null, created_at: '2026-09-01T00:00:00.000Z', ...over });
type Robot = { tab: Tab; alive: boolean; progress: { task_id: string; title: string; done: number; total: number } | null };
const city = (robots: Robot[] = [{ tab: tab(), alive: true, progress: null }], shortUrl: string | null = null) =>
  toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl, buildings: [{ project: project(), robots }] });

describe('the public payload', () => {
  it('emits exactly the fields the public city is allowed to carry', () => {
    const c = city([{ tab: tab(), alive: true, progress: { task_id: 'k', title: 'segredo do board', done: 2, total: 5 } }]);
    expect(Object.keys(c).sort()).toEqual(['buildings', 'nickname', 'owner_name', 'short_url']);
    expect(Object.keys(c.buildings[0]).sort()).toEqual(['id', 'name', 'robots']);
    expect(Object.keys(c.buildings[0].robots[0]).sort()).toEqual(['activity', 'activity_verb', 'alive', 'id', 'kind', 'name', 'progress', 'state', 'state_at']);
    expect(c.buildings[0].robots[0].progress).toEqual({ done: 2, total: 5 });
    expect(JSON.stringify(c)).not.toContain('segredo do board');
  });

  // city-by-project §2.3: a building is a published project, under its project's public id
  it('makes the building of a published project its project, by name, under an id that is not the real one', () => {
    const c = city();
    expect(c.buildings[0].name).toBe('Engage Easy');
    expect(c.buildings[0].id).toBe(publicId('project', 'p1'));
    expect(c.buildings[0].id).not.toBe('p1');
  });

  it('carries nothing that describes a machine or the person beyond a name', () => {
    const body = JSON.stringify(city());
    for (const secret of ['maquina-secreta-id', 'machine', 'not-emitted', '/home/p/engageasy', 'o que eu não quero na rua', 'th-t1', 'u1', 'rodando os testes', 'claude']) {
      expect(body).not.toContain(secret);
    }
  });

  it('replaces every real id with one that is not the real id, and does it the same way twice', () => {
    const once = city();
    const twice = city();
    expect(once.buildings[0].robots[0].id).not.toBe('t1');
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(publicId('tab', 't1')).not.toBe(publicId('project', 't1'));
  });

  it('a robot that is not working carries no activity and keeps its state', () => {
    const r = toPublicRobot(tab({ state: 'waiting_input', activity: null }), { alive: true, progress: null });
    expect(r.state).toBe('waiting_input');
    expect(r.activity).toBeNull();
  });

  it('publishes a spinner verb only when it is one of Claude Code\'s defaults', () => {
    const robot = (verb: string | null) => toPublicRobot(tab({ activity_verb: verb }), { alive: true, progress: null }).activity_verb;
    expect(robot('Moonwalking')).toBe('Moonwalking');
    expect(robot('Flibbertigibbeting')).toBe('Flibbertigibbeting');
    expect(robot(null)).toBeNull();
    // a customised verb is the person's own words: it stays in the office
    for (const custom of ['Acmeing', 'Deploying', 'moonwalking', 'MOONWALKING', 'toString', 'constructor', '__proto__']) expect(robot(custom)).toBeNull();
  });

  it('publishes activity and verb only while the robot is working, whatever the row still holds', () => {
    for (const state of ['waiting_input', 'waiting_permission', 'idle', 'error', null] as const) {
      const r = toPublicRobot(tab({ state, activity: 'coding', activity_verb: 'Moonwalking' }), { alive: true, progress: null });
      expect([r.state, r.activity, r.activity_verb]).toEqual([state, null, null]);
    }
    const working = toPublicRobot(tab({ state: 'working', activity: 'coding', activity_verb: 'Moonwalking' }), { alive: true, progress: null });
    expect([working.activity, working.activity_verb]).toEqual(['coding', 'Moonwalking']);
  });

  it('keeps a custom verb out of the whole payload', () => {
    expect(JSON.stringify(city([{ tab: tab({ activity_verb: 'Acmeing' }), alive: true, progress: null }]))).not.toContain('Acmeing');
  });

  // The snapshot, the socket frames and the share link all join on the building id.
  it('gives the frames the building and robot ids of the snapshot, and nothing else', () => {
    const c = city();
    const frame = toPublicRobotFrame({ projectId: 'p1', tab: tab(), alive: true, progress: null });
    expect(Object.keys(frame).sort()).toEqual(['building', 'robot', 'type']);
    expect(frame.building).toBe(c.buildings[0].id);
    expect(frame.robot).toEqual(c.buildings[0].robots[0]);
    expect(toPublicRobotGone({ projectId: 'p1', tabId: 't1' })).toEqual({ type: 'robot_gone', building: c.buildings[0].id, robot: c.buildings[0].robots[0].id });
  });

  // city-by-project §1: one building per project, whatever machines its agents run on
  it('keeps one building for a project whose robots run on two machines, and its frames agree', () => {
    const c = city([{ tab: tab(), alive: true, progress: null }, { tab: tab({ id: 't2', machine_id: 'outra-maquina-id' }), alive: false, progress: null }]);
    expect(c.buildings).toHaveLength(1);
    expect(c.buildings[0].robots.map((r) => r.id)).toEqual([publicId('tab', 't1'), publicId('tab', 't2')]);
    const f2 = toPublicRobotFrame({ projectId: 'p1', tab: tab({ id: 't2', machine_id: 'outra-maquina-id' }), alive: true, progress: null });
    expect(f2.building).toBe(c.buildings[0].id);
  });

  // §2.4: a published project always appears, even with no agents
  it('keeps a published project with no robot as a building of its own', () => {
    expect(city([]).buildings).toEqual([{ id: publicId('project', 'p1'), name: 'Engage Easy', robots: [] }]);
  });

  // The short link is public by nature — it is printed on images meant for strangers — and it is
  // the one field of the owner's account that travels, named here and nowhere else.
  it('carries the owner’s short link, or null', () => {
    expect(city([], 'https://77a.it/pedro').short_url).toBe('https://77a.it/pedro');
    expect(city([], null).short_url).toBeNull();
  });

  // §6: no machine id, name or subtitle in the snapshot or in any frame
  it('carries no machine, in the snapshot or in any frame', () => {
    const payloads = [city(), toPublicRobotFrame({ projectId: 'p1', tab: tab(), alive: true, progress: null }), toPublicRobotGone({ projectId: 'p1', tabId: 't1' })];
    for (const payload of payloads) {
      const body = JSON.stringify(payload);
      expect(body).not.toMatch(/machine|subtitle/);
      expect(body).not.toContain('maquina-secreta-id');
    }
  });
});
