import { describe, expect, it } from 'vitest';
import { toPublicCity, toPublicRobot } from './city.js';
import { publicId } from './public-id.js';
import { mapProject } from '../db/repositories/types.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';

const tab = (over: Partial<Tab> = {}): Tab => ({
  id: 't1', project_id: 'p1', name: 'corrigir o cliente ACME', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null,
  position: 0, state: 'working', state_text: 'rodando os testes', state_tool: 'claude', state_at: '2026-09-22T10:00:00.000Z',
  state_seen_at: null, activity: 'coding', created_at: '2026-09-22T09:00:00.000Z', ...over,
});
const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', machine_id: 'm1', name: 'Engage Easy', cwd: '/home/p/engageasy', status: 'active', description: 'o que eu não quero na rua', is_public: true, last_terminal_at: null, created_at: '2026-09-01T00:00:00.000Z', ...over });
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', name: 'Jarvis', host: '10.0.0.9', ssh_user: 'pedro', ssh_port: 22, type: 'agent', os: 'linux', capabilities: ['claude'], checked_at: null, agent_version: '0.4.1', agent_last_seen_at: null, agent_auto_update: true, is_local: false, owner_id: 'u1', created_at: '2026-09-01T00:00:00.000Z', ...over } as Machine);

describe('the public payload', () => {
  it('emits exactly the fields the public city is allowed to carry', () => {
    const city = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: { done: 2, total: 5 } }] }] }] });
    expect(Object.keys(city).sort()).toEqual(['buildings', 'nickname', 'owner_name']);
    expect(Object.keys(city.buildings[0]).sort()).toEqual(['id', 'name', 'rooms']);
    expect(Object.keys(city.buildings[0].rooms[0]).sort()).toEqual(['id', 'name', 'robots']);
    expect(Object.keys(city.buildings[0].rooms[0].robots[0]).sort()).toEqual(['activity', 'alive', 'id', 'kind', 'name', 'progress', 'state', 'state_at', 'state_seen_at'].filter((k) => k !== 'state_seen_at').sort());
  });

  it('carries nothing that describes the machine or the person beyond a name', () => {
    const body = JSON.stringify(toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] }));
    for (const secret of ['10.0.0.9', '/home/p/engageasy', 'o que eu não quero na rua', 'th-t1', 'u1', 'rodando os testes', 'claude']) {
      expect(body).not.toContain(secret);
    }
  });

  it('replaces every real id with one that is not the real id, and does it the same way twice', () => {
    const once = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] });
    const twice = toPublicCity({ nickname: 'pedro', ownerName: 'Pedro', buildings: [{ machine: machine(), rooms: [{ project: project(), tabs: [{ tab: tab(), alive: true, progress: null }] }] }] });
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

  it('the id a project carries for the app is the id the city shows', () => {
    expect(mapProject({ id: 'p1', machineId: 'm1', name: 'x', cwd: '/w', status: 'active', description: null, isPublic: true, lastTerminalAt: null, createdAt: new Date() } as never).public_id).toBe(publicId('project', 'p1'));
  });
});
