import { describe, expect, it } from 'vitest';
import type { BuildingModel, FocusTarget } from '../model';
import { buildingSignText, deskLabelsVisible, LABEL_SCALE } from './detail';

const city: FocusTarget = { kind: 'city' };
const inside: FocusTarget = { kind: 'building', projectId: 'p1' };
const far = LABEL_SCALE / 4;

describe('deskLabelsVisible', () => {
  it('shows every desk label only once the zoom makes them readable', () => {
    expect(deskLabelsVisible(city, far, 'p1')).toBe(false);
    expect(deskLabelsVisible(city, LABEL_SCALE, 'p1')).toBe(true);
  });
  it('always labels the desks of the building the person stands in, and only those', () => {
    expect(deskLabelsVisible(inside, far, 'p1')).toBe(true);
    expect(deskLabelsVisible(inside, far, 'p2')).toBe(false);
  });
});

// city-by-project §3.2: the building sign merges the old machine and room signs
describe('buildingSignText', () => {
  const b = (over: Partial<BuildingModel> = {}) => ({ label: 'termhub', notice: null, progress: null, needsYou: 0, desks: [{}], ...over }) as BuildingModel;
  it('is the name alone for a quiet building', () => {
    expect(buildingSignText(b())).toEqual({ name: 'termhub', detail: '', count: '' });
  });
  it('says the board and who is waiting', () => {
    expect(buildingSignText(b({ progress: { done: 2, total: 5 }, needsYou: 1 }))).toEqual({ name: 'termhub', detail: '2/5 tarefas ·', count: '1 precisa de você' });
    expect(buildingSignText(b({ needsYou: 3 }))).toEqual({ name: 'termhub', detail: '', count: '3 precisam de você' });
  });
  it('puts the notice first, in pt-BR', () => {
    expect(buildingSignText(b({ notice: 'offline', progress: { done: 1, total: 2 } })).detail).toBe('offline · 1/2 tarefas');
    expect(buildingSignText(b({ notice: 'silent' })).detail).toBe('sem resposta');
  });
  // §2.4: a published project with nobody in it is still a building — and says so
  it('says so when a building has no agent right now', () => {
    expect(buildingSignText(b({ desks: [] })).detail).toBe('sem agentes agora');
  });
});
