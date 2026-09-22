// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCity } from '../lib/types';

// vi.mock factories are hoisted above this file's own imports, so everything they reference has to
// be created through vi.hoisted() — the same rule OfficePage.test.tsx works under.
const { FakeOfficeScene, socket } = vi.hoisted(() => {
  /** The scene stub OfficePage.test.tsx installs: no WebGL in jsdom, so it only records. */
  class FakeOfficeScene {
    static instances: FakeOfficeScene[] = [];
    handlers: { onPickDesk: (tabId: string, projectId: string) => void; onPickRoom: (machineId: string, roomId: string) => void; onPickMachine: (machineId: string) => void; onPickSign: (id: string) => void; onGoUp: () => void };
    setModel = vi.fn();
    focus = vi.fn();
    destroy = vi.fn();
    constructor(handlers: FakeOfficeScene['handlers']) {
      this.handlers = handlers;
      FakeOfficeScene.instances.push(this);
    }
    async mount(): Promise<void> {}
  }
  /** The fake /ws/public channel: `emit` hands a parsed frame to the callback openCitySocket was given. */
  const socket = {
    onRobot: null as ((frame: unknown) => void) | null,
    closed: 0,
    emit(frame: unknown) {
      socket.onRobot?.(frame);
    },
  };
  return { FakeOfficeScene, socket };
});

vi.mock('../office/scene/OfficeScene', () => ({ OfficeScene: FakeOfficeScene }));
// only the socket is faked: fetchCity and toMachineEntries are the real ones, over a stubbed fetch
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  openCitySocket: (_nickname: string, onRobot: (frame: unknown) => void) => {
    socket.onRobot = onRobot;
    return () => {
      socket.closed += 1;
      socket.onRobot = null;
    };
  },
}));

import { CityPage } from './CityPage';

const AT = '2026-09-22T10:00:00.000Z';
const LATER = '2026-09-22T10:05:00.000Z';
const CITY: PublicCity = { nickname: 'pedro', owner_name: 'Pedro', buildings: [{ id: 'b1', name: 'Jarvis', rooms: [{ id: 'r1', name: 'Engage Easy', robots: [{ id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: AT, activity: 'coding', alive: true, progress: null }] }] }] };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
const scene = () => FakeOfficeScene.instances[0];
/** what the page last handed the scene, as the office's own CityModel */
const desks = (city: unknown) => ({ machines: [expect.objectContaining({ floor: expect.objectContaining({ rooms: [expect.objectContaining({ desks: [expect.objectContaining(city as object)] })] }) })] });

beforeEach(() => {
  FakeOfficeScene.instances = [];
  fetchMock.mockReset();
  socket.onRobot = null;
  socket.closed = 0;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CityPage', () => {
  it('draws the city of the nickname in the URL and says whose it is', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);

    expect(await screen.findByText(/Pedro/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/public/city/pedro');
    expect(screen.getByRole('link', { name: /criar minha conta/i }).getAttribute('href')).toContain('termhub.dev');
  });

  it('shows the not-found state for a city that does not answer', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="ninguem" />);

    expect(await screen.findByText(/cidade não encontrada/i)).toBeTruthy();
  });

  it('applies a live robot frame without refetching the snapshot', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Pedro/);
    expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'coding' })));

    act(() => socket.emit({ type: 'robot', building: 'b1', room: 'r1', robot: { ...CITY.buildings[0].rooms[0].robots[0], activity: 'reading', state_at: LATER } }));

    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'reading' }))));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
