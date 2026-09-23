// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  /**
   * The fake /ws/public channel: `emit` hands a parsed frame to the callback openCitySocket was
   * given, and `hangUp` is the server closing the socket — what it does when the last published
   * room is taken off the street.
   */
  const socket = {
    onRobot: null as ((frame: unknown) => void) | null,
    onClosed: null as (() => void) | null,
    opened: 0,
    closed: 0,
    emit(frame: unknown) {
      socket.onRobot?.(frame);
    },
    hangUp() {
      socket.onClosed?.();
    },
  };
  return { FakeOfficeScene, socket };
});

vi.mock('../office/scene/OfficeScene', () => ({ OfficeScene: FakeOfficeScene }));
// only the socket is faked: fetchCity and toMachineEntries are the real ones, over a stubbed fetch
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  openCitySocket: (_nickname: string, handlers: { onRobot: (frame: unknown) => void; onClosed: () => void }) => {
    socket.opened += 1;
    socket.onRobot = handlers.onRobot;
    socket.onClosed = handlers.onClosed;
    return () => {
      socket.closed += 1;
      socket.onRobot = null;
      socket.onClosed = null;
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
  socket.onClosed = null;
  socket.opened = 0;
  socket.closed = 0;
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const card = () => screen.queryByRole('region', { name: /beta gratuito/i });

describe('CityPage', () => {
  it('draws the city of the nickname in the URL and says whose it is', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);

    expect(await screen.findByText(/Cidade de Pedro/)).toBeTruthy();
    // no credentials on a public read, structurally and not by luck of the default
    expect(fetchMock).toHaveBeenCalledWith('/api/public/city/pedro', { credentials: 'omit' });
    expect(screen.getByRole('button', { name: /participar do beta grátis/i })).toBeTruthy();
  });

  it('opens the beta card on a first visit, naming whose agents these are', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);

    expect(card()).toBeTruthy();
    expect(screen.getByText(/agentes de IA de Pedro trabalhando ao vivo/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /entrar no beta gratuito/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /conheça o termhub/i }).getAttribute('href')).toBe('https://termhub.dev/');
  });

  it('remembers a collapsed card on the next visit, and the top-bar button opens it again', async () => {
    fetchMock.mockImplementation(async () => json(CITY));
    const first = render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    fireEvent.click(screen.getByRole('button', { name: /recolher/i }));
    expect(card()).toBeNull();
    first.unmount();

    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    expect(card()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /participar do beta grátis/i }));
    expect(card()).toBeTruthy();
  });

  it('works without storage: open on arrival, still collapses and reopens', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);

    expect(card()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /recolher/i }));
    expect(card()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /participar do beta grátis/i }));
    expect(card()).toBeTruthy();
  });

  it('shows the beta card, open and without a name, on the not-found page', async () => {
    // a visitor who collapsed it on another city still gets it here: this page has nothing else to show
    localStorage.setItem('termhub:city-beta-collapsed', '1');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="ninguem" />);
    await screen.findByText(/cidade não encontrada/i);

    expect(card()).toBeTruthy();
    expect(screen.getByText(/cada robô é um terminal de verdade/)).toBeTruthy();
    expect(screen.queryByText(/agentes de IA de/)).toBeNull();
  });

  it('shows the not-found state for a city that does not answer', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="ninguem" />);

    expect(await screen.findByText(/cidade não encontrada/i)).toBeTruthy();
  });

  it('applies a live robot frame without refetching the snapshot', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'coding' })));

    act(() => socket.emit({ type: 'robot', building: 'b1', room: 'r1', robot: { ...CITY.buildings[0].rooms[0].robots[0], activity: 'reading', state_at: LATER } }));

    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'reading' }))));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A tab closed or deleted while somebody watches leaves the room, instead of sitting there until a reload.
  it('removes a robot when the channel says its tab is gone', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'coding' })));

    act(() => socket.emit({ type: 'robot_gone', building: 'b1', room: 'r1', robot: 'x1' }));

    await waitFor(() =>
      expect(scene().setModel).toHaveBeenLastCalledWith(
        expect.objectContaining({ machines: [expect.objectContaining({ floor: expect.objectContaining({ rooms: [expect.objectContaining({ desks: [] })] }) })] }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('goes to the not-found state, without a reload, when the city is unpublished under the visitor', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY)).mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);

    // the server hangs the socket up when the last published room comes off the street
    await act(async () => {
      socket.hangUp();
    });

    expect(await screen.findByText(/cidade não encontrada/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops knocking once a city is known not to be there', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="ninguem" />);
    await screen.findByText(/cidade não encontrada/i);

    // opened once on arrival, then closed for good: no channel is kept open for a 404
    expect(socket.opened).toBe(1);
    expect(socket.closed).toBe(1);
    expect(socket.onClosed).toBeNull();
  });

  it('does not call a city missing when it merely could not be read, and comes back', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(json(CITY));
      render(<CityPage nickname="pedro" />);
      await act(async () => {});

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // a server that could not answer is not a city that does not exist
      expect(screen.queryByText(/cidade não encontrada/i)).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByText(/Cidade de Pedro/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
