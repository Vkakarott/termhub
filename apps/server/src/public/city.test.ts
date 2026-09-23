import { describe, expect, it } from 'vitest';
import { toPublicCity, toPublicRobot, toPublicRobotFrame, toPublicRobotGone } from './city.js';
import { publicId, publicRoomId } from './public-id.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';

const tab = (over: Partial<Tab> = {}): Tab => ({
  id: 't1', project_id: 'p1', machine_id: 'm1', name: 'corrigir o cliente ACME', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null,
  position: 0, state: 'working', state_text: 'rodando os testes', state_tool: 'claude', state_at: '2026-09-22T10:00:00.000Z',
  state_seen_at: null, activity: 'coding', activity_verb: null, created_at: '2026-09-22T09:00:00.000Z', ...over,
});
const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', owner_id: 'u1', key: 'ENG', next_task_number: 1, name: 'Engage Easy', status: 'active', description: 'o que eu não quero na rua', is_public: true, last_terminal_at: null, created_at: '2026-09-01T00:00:00.000Z', ...over });
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', name: 'Jarvis', host: '10.0.0.9', ssh_user: 'pedro', ssh_port: 22, type: 'agent', os: 'linux', capabilities: ['claude'], checked_at: null, agent_version: '0.4.1', agent_last_seen_at: null, agent_auto_update: true, is_local: false, owner_id: 'u1', created_at: '2026-09-01T00:00:00.000Z', ...over } as Machine);

describe('the public payload', () => {
  it('emits exactly the fields the public city is allowed to carry', () => {
    const city = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl: null, buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: { done: 2, total: 5 } }] }] }] });
    expect(Object.keys(city).sort()).toEqual(['buildings', 'nickname', 'owner_name', 'short_url']);
    expect(Object.keys(city.buildings[0]).sort()).toEqual(['id', 'name', 'rooms']);
    expect(Object.keys(city.buildings[0].rooms[0]).sort()).toEqual(['id', 'name', 'robots']);
    expect(Object.keys(city.buildings[0].rooms[0].robots[0]).sort()).toEqual(['activity', 'activity_verb', 'alive', 'id', 'kind', 'name', 'progress', 'state', 'state_at', 'state_seen_at'].filter((k) => k !== 'state_seen_at').sort());
  });

  it('carries nothing that describes the machine or the person beyond a name', () => {
    const body = JSON.stringify(toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl: null, buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] }));
    for (const secret of ['10.0.0.9', '/home/p/engageasy', 'o que eu não quero na rua', 'th-t1', 'u1', 'rodando os testes', 'claude']) {
      expect(body).not.toContain(secret);
    }
  });

  it('replaces every real id with one that is not the real id, and does it the same way twice', () => {
    const once = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl: null, buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] });
    const twice = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl: null, buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] });
    const b = once.buildings[0];
    expect(b.id).not.toBe('m1');
    expect(b.rooms[0].id).not.toBe('p1');
    expect(b.rooms[0].robots[0].id).not.toBe('t1');
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
    const body = JSON.stringify(toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab({ activity_verb: 'Acmeing' }), alive: true, progress: null }] }] }] }));
    expect(body).not.toContain('Acmeing');
  });

  // Merge ruling 3: a project linked to two machines has a room on each, and the two must not share
  // an id — the snapshot, the socket frames and the share link all join on it.
  it('gives the same project a different room id on each building, and the frames agree with the snapshot', () => {
    const city = toPublicCity({
      nickname: 'pedro',
      ownerName: 'Pedro',
      shortUrl: null,
      buildings: [
        { machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] },
        { machine: machine({ id: 'm2', name: 'Friday' }), rooms: [{ project: project(), tabs: [{ tab: tab({ id: 't2', machine_id: 'm2' }), alive: true, progress: null }] }] },
      ],
    });
    const [a, b] = city.buildings;
    expect(a.rooms[0].id).not.toBe(b.rooms[0].id);
    expect(a.rooms[0].id).toBe(publicRoomId('p1', 'm1'));
    expect(b.rooms[0].id).toBe(publicRoomId('p1', 'm2'));
    const frame = toPublicRobotFrame({ machineId: 'm2', projectId: 'p1', tab: tab({ id: 't2', machine_id: 'm2' }), alive: true, progress: null });
    expect(Object.keys(frame).sort()).toEqual(['building', 'robot', 'room', 'type']);
    expect(frame.building).toBe(b.id);
    expect(frame.room).toBe(b.rooms[0].id);
    expect(frame.robot).toEqual(b.rooms[0].robots[0]);
    expect(toPublicRobotGone({ machineId: 'm2', projectId: 'p1', tabId: 't2' })).toEqual({ type: 'robot_gone', building: b.id, room: b.rooms[0].id, robot: b.rooms[0].robots[0].id });
  });

  // The short link is public by nature — it is printed on images meant for strangers — and it is
  // the one field of the owner's account that travels, named here and nowhere else.
  it('carries the owner’s short link, or null', () => {
    const withLink = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl: 'https://77a.it/pedro', buildings: [] });
    expect(withLink.short_url).toBe('https://77a.it/pedro');
    expect(toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', shortUrl: null, buildings: [] }).short_url).toBeNull();
  });
});
