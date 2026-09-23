// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./Sidebar', () => ({ Sidebar: () => <p>projects-sidebar</p> }));
vi.mock('./SettingsSidebar', () => ({ SettingsSidebar: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>settings-sidebar</button> }));
vi.mock('./SidebarRail', () => ({
  SidebarRail: ({ mode, onBack }: { mode: string; onBack: () => void }) => <button onClick={onBack}>{`rail-${mode}`}</button>,
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

afterEach(cleanup);

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
