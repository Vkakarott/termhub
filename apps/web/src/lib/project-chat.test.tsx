// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectChatProvider, useProjectChat } from './project-chat';

const projectsMock = vi.fn();
let emit!: (e: unknown) => void;
vi.mock('./api', () => ({ api: { chatProjects: (...a: unknown[]) => projectsMock(...a) } }));
vi.mock('./chat', () => ({ useChatStream: (_r: unknown, cb: (e: unknown) => void) => ((emit = cb), { events: [], connected: true }) }));

afterEach(cleanup);

function Probe() {
  const { openProjectId, toggle, status } = useProjectChat();
  return (
    <>
      <span data-testid="open">{openProjectId ?? 'none'}</span>
      <span data-testid="p1">{JSON.stringify(status('p1'))}</span>
      <button onClick={() => toggle('p1')}>p1</button>
      <button onClick={() => toggle('p2')}>p2</button>
    </>
  );
}

it('toggle opens, swaps and closes', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  // `getByRole('button', ...)`, not `getByText`: once `open` reads "p2" the plain text query would
  // also match that status span, since it shows the very string being clicked.
  act(() => screen.getByRole('button', { name: 'p1' }).click());
  expect(screen.getByTestId('open').textContent).toBe('p1');
  act(() => screen.getByRole('button', { name: 'p2' }).click());
  expect(screen.getByTestId('open').textContent).toBe('p2');
  act(() => screen.getByRole('button', { name: 'p2' }).click());
  expect(screen.getByTestId('open').textContent).toBe('none');
});

it('reads statuses on load and re-reads them on chat events', async () => {
  projectsMock.mockResolvedValueOnce({ projects: [{ project_id: 'p1', busy: false, pending_confirmations: 1 }] }).mockResolvedValue({ projects: [{ project_id: 'p1', busy: true, pending_confirmations: 0 }] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":1}'));
  act(() => emit({ type: 'message', conversation_id: 'c_p1', message: {} }));
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":true,"pending":0}'));
});

it('works without a provider (the sidebar in isolation): closed, no status', () => {
  render(<Probe />);
  expect(screen.getByTestId('open').textContent).toBe('none');
  expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":0}');
});
