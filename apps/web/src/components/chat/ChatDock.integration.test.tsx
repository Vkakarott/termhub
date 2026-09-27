// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectChatProvider, useChatScope } from '../../lib/project-chat';
import { ChatDock } from './ChatDock';

// Everything below the provider (server, socket, auth, project list) is stubbed; the provider itself
// and `ChatDock` are the real modules, so this exercises the wiring between them (unlike ChatDock.test.tsx,
// which mocks `lib/project-chat` too and can never catch a bug in that wiring).
const mounts = vi.hoisted(() => new Map<string, number>());
vi.mock('./ChatPanel', async () => {
  const { useEffect } = await import('react');
  return {
    ChatPanel: ({ projectId }: { projectId: string }) => {
      useEffect(() => void mounts.set(projectId, (mounts.get(projectId) ?? 0) + 1), []);
      return <div>painel {projectId}</div>;
    },
  };
});
vi.mock('../../lib/api', () => ({ api: { chatProjects: () => Promise.resolve({ projects: [] }) } }));
vi.mock('../../lib/chat', () => ({ useChatStream: () => ({ connected: true }) }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../lib/data', () => ({
  useData: () => ({ projects: [{ id: 'p1', name: 'termhub' }, { id: 'p2', name: 'engenharia inversa' }] }),
}));

/** A page that says which project is on screen, like ProjectPage. */
function Page({ id }: { id: string }) {
  useChatScope(id);
  return null;
}

const renderApp = (id: string) =>
  render(
    <ProjectChatProvider>
      <Page id={id} />
      <ChatDock />
    </ProjectChatProvider>,
  );

afterEach(() => {
  cleanup();
  mounts.clear();
  localStorage.clear();
});

it('a real provider drives the dock: switching pages keeps the panel mounted and hidden, closing unmounts it and persists', () => {
  localStorage.setItem('termhub:project-chat', JSON.stringify({ p1: { open: true, width: 500, maximized: false } }));

  const { rerender } = renderApp('p1');
  const shownOnP1 = screen.getByRole('complementary', { name: 'Chat · termhub' });
  expect(shownOnP1.style.width).toBe('500px');
  expect(mounts.get('p1')).toBe(1);

  // p2's pref was never stored, so it starts closed: nothing shows, but p1 (open, just not on screen
  // any more) stays mounted, hidden and inert.
  rerender(
    <ProjectChatProvider>
      <Page id="p2" />
      <ChatDock />
    </ProjectChatProvider>,
  );
  expect(screen.queryByRole('complementary')).toBeNull();
  const hiddenP1 = screen.getByText('painel p1').closest('aside')!;
  expect(hiddenP1.hasAttribute('inert')).toBe(true);
  expect(mounts.get('p1')).toBe(1);

  // Back to p1: shown again, never remounted.
  rerender(
    <ProjectChatProvider>
      <Page id="p1" />
      <ChatDock />
    </ProjectChatProvider>,
  );
  expect(screen.getByRole('complementary', { name: 'Chat · termhub' })).toBeTruthy();
  expect(mounts.get('p1')).toBe(1);

  fireEvent.click(screen.getByRole('button', { name: 'Fechar chat' }));
  expect(screen.queryByText('painel p1')).toBeNull();
  expect(JSON.parse(localStorage.getItem('termhub:project-chat')!).p1.open).toBe(false);
});
