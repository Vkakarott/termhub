// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./Sidebar', async () => {
  const { Link } = await import('react-router-dom');
  return {
    Sidebar: () => (
      <>
        <p>projects-sidebar</p>
        <Link to="/settings/profile" data-chrome-focus="profile">
          perfil
        </Link>
      </>
    ),
  };
});
vi.mock('./SettingsSidebar', () => ({
  SettingsSidebar: ({ onBack }: { onBack: () => void }) => (
    <button onClick={onBack} data-chrome-focus="settings-back">
      settings-sidebar
    </button>
  ),
}));
vi.mock('./SidebarRail', () => ({
  SidebarRail: ({ mode, onBack }: { mode: string; onBack: () => void }) => (
    <button onClick={onBack} data-chrome-focus={mode === 'settings' ? 'settings-back' : 'profile'}>{`rail-${mode}`}</button>
  ),
}));
vi.mock('./chat/ChatDrawer', () => ({ ChatDrawer: () => null }));

import { FocusProvider } from '../lib/focus';
import { Chrome } from './Layout';

function mount(path: string, collapsed = false) {
  const onLeaveSettings = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <FocusProvider>
        <Chrome collapsed={collapsed} setCollapsed={() => {}} onLeaveSettings={onLeaveSettings} />
      </FocusProvider>
    </MemoryRouter>,
  );
  return onLeaveSettings;
}

/** Chrome with a real way back (to /machines) and a link into settings from the page content. */
function Navigating({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  return (
    <>
      <Chrome collapsed={collapsed} setCollapsed={() => {}} onLeaveSettings={() => void navigate('/machines')} />
      <Link to="/settings/integrations">link na página</Link>
      {/* drops focus before navigating, as the real profile button does when its sidebar unmounts */}
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          void navigate('/settings/profile');
        }}
      >
        ir às configurações
      </button>
    </>
  );
}
function mountNavigating(path: string, collapsed = false) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <FocusProvider>
        <Navigating collapsed={collapsed} />
      </FocusProvider>
    </MemoryRouter>,
  );
}
/** Keyboard activation: focus the control, then activate it. */
function activate(el: HTMLElement) {
  el.focus();
  fireEvent.click(el);
}

afterEach(cleanup);

describe('Chrome focus when the sidebar swaps', () => {
  it('entering settings from the profile row focuses the way back; leaving focuses the profile row', () => {
    mountNavigating('/machines');
    activate(screen.getByText('perfil'));
    expect(document.activeElement).toBe(screen.getByText('settings-sidebar'));
    activate(screen.getByText('settings-sidebar'));
    expect(document.activeElement).toBe(screen.getByText('perfil'));
  });

  it('does the same in the rail', () => {
    mountNavigating('/machines', true);
    activate(screen.getByText('ir às configurações'));
    expect(document.activeElement).toBe(screen.getByText('rail-settings'));
  });

  it('leaves focus alone when it is still on something in the page', () => {
    mountNavigating('/machines');
    activate(screen.getByText('link na página'));
    expect(screen.getByText('settings-sidebar')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText('link na página'));
  });

  it('does not take focus when the app opens straight on settings', () => {
    mountNavigating('/settings/users');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Chrome', () => {
  it('shows the projects sidebar outside settings', () => {
    mount('/machines');
    expect(screen.getByText('projects-sidebar')).toBeTruthy();
    expect(screen.queryByText('settings-sidebar')).toBeNull();
  });

  it('swaps in the settings sidebar under /settings, wired to the way back', () => {
    const leave = mount('/settings/users');
    expect(screen.queryByText('projects-sidebar')).toBeNull();
    fireEvent.click(screen.getByText('settings-sidebar'));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('hides all chrome in the office focus mode', () => {
    mount('/office?focus=1');
    expect(screen.queryByText('projects-sidebar')).toBeNull();
    expect(screen.queryByText('settings-sidebar')).toBeNull();
  });

  it('collapsed, shows the rail with the projects outside settings', () => {
    mount('/machines', true);
    expect(screen.getByText('rail-main')).toBeTruthy();
    expect(screen.queryByText('projects-sidebar')).toBeNull();
  });

  it('collapsed under /settings, shows the settings rail wired to the way back', () => {
    const leave = mount('/settings/users', true);
    fireEvent.click(screen.getByText('rail-settings'));
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
