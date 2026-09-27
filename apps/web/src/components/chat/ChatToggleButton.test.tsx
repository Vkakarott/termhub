// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ open: false, status: { busy: false, pending: 0 }, canChat: true, toggle: vi.fn() }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ can: (r: string) => (r === 'chat' ? state.canChat : true) }) }));
vi.mock('../../lib/project-chat', () => ({
  useProjectChat: () => ({ pref: () => ({ open: state.open, width: 420, maximized: false }), toggle: state.toggle, status: () => state.status }),
}));

import { ChatToggleButton } from './ChatToggleButton';

afterEach(() => {
  cleanup();
  state.open = false;
  state.status = { busy: false, pending: 0 };
  state.canChat = true;
  vi.clearAllMocks();
});

it('toggles the project chat and says whether it is open', () => {
  render(<ChatToggleButton projectId="p1" />);
  const b = screen.getByRole('button', { name: 'Chat do projeto' });
  expect(b.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(b);
  expect(state.toggle).toHaveBeenCalledWith('p1');
});

it('is pressed while open', () => {
  state.open = true;
  render(<ChatToggleButton projectId="p1" />);
  expect(screen.getByRole('button', { name: 'Chat do projeto' }).getAttribute('aria-pressed')).toBe('true');
});

it('shows the attention dot while something waits on the person', () => {
  state.status = { busy: false, pending: 2 };
  render(<ChatToggleButton projectId="p1" />);
  const b = screen.getByRole('button', { name: 'Chat do projeto' });
  expect(b.getAttribute('title')).toBe('Chat do projeto — esperando sua confirmação');
  expect(b.querySelector('.bg-attention')).not.toBeNull();
});

it('renders nothing without the chat permission', () => {
  state.canChat = false;
  const { container } = render(<ChatToggleButton projectId="p1" />);
  expect(container.innerHTML).toBe('');
});
