import { describe, expect, it } from 'vitest';
import { homeStep, nextSteps, starterProjects } from './home-onboarding';
import type { Machine, Project, ProjectGroup, Tab } from './types';

const machine = (id: string, over: Partial<Machine> = {}) => ({ id, name: id, type: 'agent', hooks_installed_at: '2026-09-01', ...over }) as Machine;
const project = (id: string, over: Partial<Project> = {}) => ({ id, name: id, status: 'active', is_public: true, machines: [], ...over }) as Project;
const tab = { id: 't1' } as Tab;
const favorites = (project_ids: string[]): ProjectGroup => ({ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids });

const base = { loading: false, machines: [machine('m1')], projects: [project('p1')], openTabs: [tab] };

describe('homeStep', () => {
  it('is loading while loading, whatever the lists say', () => {
    expect(homeStep({ ...base, loading: true, machines: [] })).toBe('loading');
  });

  it('walks the required steps in order', () => {
    expect(homeStep({ ...base, machines: [], projects: [], openTabs: [] })).toBe(1);
    expect(homeStep({ ...base, projects: [], openTabs: [] })).toBe(2);
    expect(homeStep({ ...base, openTabs: [] })).toBe(3);
    expect(homeStep(base)).toBe('dashboard');
  });

  it('falls back to the dashboard instead of a step it cannot know', () => {
    expect(homeStep({ ...base, machines: [], machinesFailed: true })).toBe('dashboard');
    expect(homeStep({ ...base, projects: [], projectsFailed: true })).toBe('dashboard');
    expect(homeStep({ ...base, openTabs: [], openTabsFailed: true })).toBe('dashboard');
  });

  it('still uses a list that failed later but holds data from an earlier read', () => {
    expect(homeStep({ ...base, projects: [], machinesFailed: true })).toBe(2);
  });
});

describe('homeStep for lists the role cannot read', () => {
  it('skips step 1 without machines:read', () => {
    expect(homeStep({ ...base, machines: [], projects: [], openTabs: [], machinesUnreadable: true })).toBe(2);
    expect(homeStep({ ...base, machines: [], openTabs: [], machinesUnreadable: true })).toBe(3);
  });

  it('never shows steps 2 and 3 without projects:read', () => {
    expect(homeStep({ ...base, projects: [], openTabs: [], projectsUnreadable: true })).toBe('dashboard');
    expect(homeStep({ ...base, openTabs: [], projectsUnreadable: true })).toBe('dashboard');
    expect(homeStep({ ...base, machines: [], projects: [], projectsUnreadable: true })).toBe(1);
  });
});

describe('starterProjects', () => {
  it('keeps the first three projects that are not archived', () => {
    const ps = [project('a', { status: 'archived' }), project('b'), project('c', { status: 'paused' }), project('d'), project('e')];
    expect(starterProjects(ps).map((p) => p.id)).toEqual(['b', 'c', 'd']);
  });

  it('falls back to archived projects when every project is archived', () => {
    const ps = [project('a', { status: 'archived' }), project('b', { status: 'archived' })];
    expect(starterProjects(ps).map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('nextSteps', () => {
  const done = { machines: [machine('m1')], projects: [project('p1')], groups: [favorites(['p1'])], nickname: 'pedro', canUpdateMachines: true };

  it('is empty when everything is done', () => {
    expect(nextSteps(done)).toEqual([]);
  });

  it('lists hooks, then city, then favorites', () => {
    const steps = nextSteps({ ...done, machines: [machine('m1', { hooks_installed_at: null })], nickname: null, groups: [favorites([])] });
    expect(steps.map((s) => s.kind)).toEqual(['hooks', 'city', 'favorites']);
  });

  it('only counts agent machines whose hooks the server says are missing', () => {
    const machines = [machine('a', { hooks_installed_at: null }), machine('b', { hooks_installed_at: undefined }), machine('c', { type: 'ssh', hooks_installed_at: null })];
    const [hooks] = nextSteps({ ...done, machines });
    expect(hooks).toEqual({ kind: 'hooks', machines: [machines[0]] });
    expect(nextSteps({ ...done, machines, canUpdateMachines: false })).toEqual([]);
  });

  it('asks for the city until there is a nickname and one public project', () => {
    expect(nextSteps({ ...done, nickname: null })).toEqual([{ kind: 'city', hasNickname: false }]);
    expect(nextSteps({ ...done, projects: [project('p1', { is_public: false })] })).toEqual([{ kind: 'city', hasNickname: true }]);
  });

  it('leaves Favoritos out when the groups are unknown', () => {
    expect(nextSteps({ ...done, groups: [] })).toEqual([]);
  });
});
