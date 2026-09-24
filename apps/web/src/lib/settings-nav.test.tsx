// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Link, MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { Modal, useEscapeLayer } from '../components/Modal';
import { isSettingsPath, keepsEscape, useSettingsExit } from './settings-nav';

/** Stands in for Layout: stays mounted while the routes under it change, like the real one. */
function Shell() {
  const leave = useSettingsExit();
  const { pathname, search } = useLocation();
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  // stands in for the chat drawer: a non-modal dialog mounted in Layout that answers Esc itself
  useEscapeLayer(drawer, () => setDrawer(false));
  return (
    <>
      <p data-testid="where">{`${pathname}${search}`}</p>
      <button onClick={leave}>voltar</button>
      <button onClick={() => setDialog(true)}>abrir diálogo</button>
      <button onClick={() => setDrawer(true)}>abrir gaveta</button>
      {drawer && (
        <aside role="dialog" aria-label="Chat">
          <textarea aria-label="mensagem" />
        </aside>
      )}
      <Link to="/settings/users">configurações</Link>
      <Link to="/integrations">integrações antigas</Link>
      <Routes>
        <Route path="/integrations" element={<Navigate to="/settings/integrations" replace />} />
        <Route
          path="/settings/:section"
          element={
            <>
              <input aria-label="nome" />
              <select aria-label="role">
                <option>a</option>
              </select>
            </>
          }
        />
        <Route path="*" element={<input aria-label="busca" />} />
      </Routes>
      <Modal open={dialog} onClose={() => setDialog(false)} title="Convidar usuário">
        <p>corpo</p>
      </Modal>
    </>
  );
}

const mount = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Shell />
    </MemoryRouter>,
  );
const where = () => screen.getByTestId('where').textContent;
const esc = (target: Element = document.body) => fireEvent.keyDown(target, { key: 'Escape' });
const enterSettings = () => fireEvent.click(screen.getByText('configurações'));

afterEach(cleanup);

describe('isSettingsPath', () => {
  it('covers /settings, its sections and the old /integrations address', () => {
    expect(['/settings', '/settings/users', '/integrations', '/waitlist', '/ai', '/hardware'].map(isSettingsPath)).toEqual([true, true, true, true, true, true]);
    expect(['/', '/machines', '/settingsx', '/projects/p1/settings'].map(isSettingsPath)).toEqual([false, false, false, false]);
  });
});

describe('keepsEscape', () => {
  it('is true in text fields and inside dialogs, false elsewhere', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inDialog = document.createElement('button');
    dialog.appendChild(inDialog);
    expect(keepsEscape(document.createElement('input'))).toBe(true);
    expect(keepsEscape(document.createElement('textarea'))).toBe(true);
    expect(keepsEscape(document.createElement('select'))).toBe(true);
    expect(keepsEscape(inDialog)).toBe(true);
    expect(keepsEscape(document.createElement('div'))).toBe(false);
  });

  it('keeps Esc only in text-like inputs, not in checkboxes, radios, buttons or ranges', () => {
    const input = (type: string) => Object.assign(document.createElement('input'), { type });
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number']) expect(keepsEscape(input(type))).toBe(true);
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']) expect(keepsEscape(input(type))).toBe(false);
    expect(keepsEscape(null)).toBe(false);
  });
});

describe('useSettingsExit', () => {
  it('the back button returns to the last page outside settings, query included', () => {
    mount('/machines?x=1');
    enterSettings();
    expect(where()).toBe('/settings/users');
    fireEvent.click(screen.getByText('voltar'));
    expect(where()).toBe('/machines?x=1');
  });

  it('Esc does the same', () => {
    mount('/machines?x=1');
    enterSettings();
    esc();
    expect(where()).toBe('/machines?x=1');
  });

  it('goes to / when settings was the first page opened', () => {
    mount('/settings/users');
    esc();
    expect(where()).toBe('/');
  });

  it('leaves Esc to a text field or a select', () => {
    mount('/machines');
    enterSettings();
    esc(screen.getByLabelText('nome'));
    expect(where()).toBe('/settings/users');
    esc(screen.getByLabelText('role'));
    expect(where()).toBe('/settings/users');
  });

  it('lets an open dialog take Esc first', () => {
    mount('/machines');
    enterSettings();
    fireEvent.click(screen.getByText('abrir diálogo'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    esc();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe('/settings/users');
    esc();
    expect(where()).toBe('/machines');
  });

  it('lets the chat drawer, opened before entering settings, take Esc first', () => {
    mount('/machines');
    fireEvent.click(screen.getByText('abrir gaveta'));
    enterSettings();
    esc();
    expect(screen.queryByRole('dialog', { name: 'Chat' })).toBeNull();
    expect(where()).toBe('/settings/users');
    esc();
    expect(where()).toBe('/machines');
  });

  it('closes the drawer with Esc from its own text field, staying in settings', () => {
    mount('/machines');
    fireEvent.click(screen.getByText('abrir gaveta'));
    enterSettings();
    esc(screen.getByLabelText('mensagem'));
    expect(screen.queryByRole('dialog', { name: 'Chat' })).toBeNull();
    expect(where()).toBe('/settings/users');
  });

  it('leaves settings with Esc from a checkbox', () => {
    mount('/machines');
    enterSettings();
    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.appendChild(box);
    esc(box);
    box.remove();
    expect(where()).toBe('/machines');
  });

  it('does not remember the old /integrations address as a page to go back to', () => {
    mount('/machines');
    fireEvent.click(screen.getByText('integrações antigas'));
    expect(where()).toBe('/settings/integrations');
    esc();
    expect(where()).toBe('/machines');
  });

  it('does nothing with Esc outside settings', () => {
    mount('/machines');
    esc();
    expect(where()).toBe('/machines');
  });
});
