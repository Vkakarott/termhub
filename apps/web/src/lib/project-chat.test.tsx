// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectChatProvider, useChatScope, useProjectChat } from './project-chat';

const projectsMock = vi.fn();
const useChatStreamMock = vi.fn((_r: unknown, cb: (e: unknown) => void) => ((emit = cb), { connected: true }));
let emit!: (e: unknown) => void;
// `can` defaults to true for both permissions the status feed needs, so the existing tests exercise
// the feed exactly as before; the gating test below overrides it.
let canMock = (_resource: string, _action?: string) => true;
vi.mock('./api', () => ({ api: { chatProjects: (...a: unknown[]) => projectsMock(...a) } }));
vi.mock('./chat', () => ({ useChatStream: (...a: [unknown, (e: unknown) => void]) => useChatStreamMock(...a) }));
vi.mock('./auth', () => ({ useAuth: () => ({ can: (r: string, a?: string) => canMock(r, a) }) }));

afterEach(() => {
  cleanup();
  canMock = () => true;
  projectsMock.mockReset();
  useChatStreamMock.mockClear();
  localStorage.clear();
});

function Probe() {
  const c = useProjectChat();
  return (
    <>
      <span data-testid="current">{c.currentProjectId ?? 'none'}</span>
      <span data-testid="shown">{c.shownProjectId ?? 'none'}</span>
      <span data-testid="alive">{c.alive.join(',')}</span>
      <span data-testid="pref-p1">{JSON.stringify(c.pref('p1'))}</span>
      <span data-testid="p1">{JSON.stringify(c.status('p1'))}</span>
      <button onClick={() => c.toggle('p1')}>toggle p1</button>
      <button onClick={() => c.setOpen('p2', true)}>open p2</button>
      <button onClick={() => c.setWidth('p1', 999)}>wide p1</button>
      <button onClick={() => c.setMaximized('p1', true)}>max p1</button>
    </>
  );
}

/** A page that says which project is on screen, like ProjectPage. */
function Page({ id }: { id: string | null }) {
  useChatScope(id);
  return null;
}

const text = (id: string) => screen.getByTestId(id).textContent;
const click = (name: string) => act(() => screen.getByRole('button', { name }).click());

it('toggle opens and closes a project chat and remembers it in localStorage', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  click('toggle p1');
  expect(text('pref-p1')).toBe('{"open":true,"width":420,"maximized":false}');
  expect(JSON.parse(localStorage.getItem('termhub:project-chat')!).p1.open).toBe(true);
  click('toggle p1');
  expect(JSON.parse(localStorage.getItem('termhub:project-chat')!).p1.open).toBe(false);
});

it('starts from what localStorage remembers', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  localStorage.setItem('termhub:project-chat', JSON.stringify({ p1: { open: true, width: 500, maximized: true } }));
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  expect(text('pref-p1')).toBe('{"open":true,"width":500,"maximized":true}');
});

it('clamps the width and stores maximized', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  click('wide p1');
  click('max p1');
  expect(text('pref-p1')).toBe('{"open":false,"width":720,"maximized":true}');
});

it('shows the chat of the project on screen only when it is open there', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  const { rerender } = render(<ProjectChatProvider><Page id="p1" /><Probe /></ProjectChatProvider>);
  expect(text('current')).toBe('p1');
  expect(text('shown')).toBe('none');
  click('toggle p1');
  expect(text('shown')).toBe('p1');
  expect(text('alive')).toBe('p1');
  // p2's chat is open, but p2 is not on screen: nothing mounts for it yet
  click('open p2');
  expect(text('alive')).toBe('p1');
  rerender(<ProjectChatProvider><Page id="p2" /><Probe /></ProjectChatProvider>);
  expect(text('shown')).toBe('p2');
  // p1 stays mounted behind p2
  expect(text('alive')).toBe('p2,p1');
});

it('closing a chat unmounts it', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Page id="p1" /><Probe /></ProjectChatProvider>);
  click('toggle p1');
  expect(text('alive')).toBe('p1');
  click('toggle p1');
  expect(text('alive')).toBe('');
  expect(text('shown')).toBe('none');
});

it('a page that goes away clears the current project; the next page takes over', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  const { rerender } = render(<ProjectChatProvider><Page id="p1" /><Probe /></ProjectChatProvider>);
  rerender(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  expect(text('current')).toBe('none');
  rerender(<ProjectChatProvider><Page id="p2" /><Probe /></ProjectChatProvider>);
  expect(text('current')).toBe('p2');
});

it('reads statuses on load and re-reads them on chat events', async () => {
  projectsMock.mockResolvedValueOnce({ projects: [{ project_id: 'p1', busy: false, pending_confirmations: 1 }] }).mockResolvedValue({ projects: [{ project_id: 'p1', busy: true, pending_confirmations: 0 }] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":1}'));
  act(() => emit({ type: 'message', conversation_id: 'c_p1', message: {} }));
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":true,"pending":0}'));
});

it.each(['tab_question', 'tab_question_answered', 'tab_question_closed'])('re-reads statuses on %s: an open question counts as pending', async (type) => {
  projectsMock.mockResolvedValueOnce({ projects: [{ project_id: 'p1', busy: false, pending_confirmations: 0 }] }).mockResolvedValue({ projects: [{ project_id: 'p1', busy: false, pending_confirmations: 1 }] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":0}'));
  act(() => emit({ type, conversation_id: 'c_p1', question: {} }));
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":1}'));
});

it('does not re-read on a suggestion event: suggestions are not counted', async () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  await waitFor(() => expect(projectsMock).toHaveBeenCalledTimes(1));
  act(() => emit({ type: 'tab_suggestion', conversation_id: 'c_p1', suggestion: {} }));
  await new Promise((r) => setTimeout(r, 20));
  expect(projectsMock).toHaveBeenCalledTimes(1);
});

it('works without a provider (a component in isolation): nothing current, closed, no status', () => {
  render(<Probe />);
  expect(text('current')).toBe('none');
  expect(text('shown')).toBe('none');
  expect(text('pref-p1')).toBe('{"open":false,"width":420,"maximized":false}');
  expect(text('p1')).toBe('{"busy":false,"pending":0}');
});

it('without chat permission, neither /chat/projects nor the ws stream is touched, and status stays idle', async () => {
  // A role without `chat` (or without `terminals:read`, which the `/ws/chat` upgrade guard also
  // requires — ws/router.ts) must never open the websocket or poll the endpoint: both 403 for that
  // role, and a websocket that keeps 403ing reconnects every 5s for the life of the tab (this
  // provider is mounted for every signed-in user in Layout).
  canMock = () => false;
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  // Give any stray microtask a turn before asserting the negative.
  await Promise.resolve();
  expect(projectsMock).not.toHaveBeenCalled();
  expect(useChatStreamMock).not.toHaveBeenCalled();
  expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":0}');
});
