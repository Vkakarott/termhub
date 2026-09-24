// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, setNicknameMock } = vi.hoisted(() => ({
  auth: { user: null as { id: string; nickname: string | null } | null },
  setNicknameMock: vi.fn(),
}));
vi.mock('../lib/api', () => ({ ApiError: class extends Error {} }));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: auth.user, publicCityUrl: 'https://termhub.dev/city', setNickname: (...a: unknown[]) => setNicknameMock(...a) }),
}));

import { NicknamePrompt } from './NicknamePrompt';

/** a page other than Início, where the prompt opens as it always did */
const at = (path: string) =>
  function Router({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
  };
const elsewhere = { wrapper: at('/projects/p1') };

beforeEach(() => {
  localStorage.clear();
  setNicknameMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('NicknamePrompt', () => {
  // Spec §4 / plan Task 7: the nickname is asked at the first sign-in, not only when publishing.
  it('asks an account with no nickname yet for one', () => {
    auth.user = { id: 'u1', nickname: null };
    render(<NicknamePrompt />, elsewhere);
    expect(screen.getByLabelText(/apelido/i)).toBeTruthy();
  });

  it('stays out of the way of an account that already has one', () => {
    auth.user = { id: 'u1', nickname: 'pedro' };
    render(<NicknamePrompt />, elsewhere);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Dismissible: the publish flow still asks later, so declining here must not nag on every load.
  it('once dismissed, is not shown again to that account', () => {
    auth.user = { id: 'u1', nickname: null };
    const { unmount } = render(<NicknamePrompt />, elsewhere);
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<NicknamePrompt />, elsewhere);
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();

    auth.user = { id: 'u2', nickname: null };
    render(<NicknamePrompt />, elsewhere);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes once the nickname is claimed', async () => {
    auth.user = { id: 'u1', nickname: null };
    render(<NicknamePrompt />, elsewhere);
    fireEvent.change(screen.getByLabelText(/apelido/i), { target: { value: 'pedro' } });
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));
    await waitFor(() => expect(setNicknameMock).toHaveBeenCalledWith('pedro'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('still works when the browser refuses storage', () => {
    auth.user = { id: 'u1', nickname: null };
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<NicknamePrompt />, elsewhere);
      fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  // Início suggests the nickname in its own "Próximos passos": the prompt would only duplicate it there
  it('does not open over Início', () => {
    auth.user = { id: 'u1', nickname: null };
    render(<NicknamePrompt />, { wrapper: at('/') });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
