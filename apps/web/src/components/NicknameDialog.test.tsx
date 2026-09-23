// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above every other top-level statement, so both the class the mocked
// `../lib/api` exports and the one this file constructs errors with have to be the SAME reference —
// hence vi.hoisted(), not a plain top-level class the mock factory could not see.
const { setNicknameMock, ApiError, auth } = vi.hoisted(() => {
  const setNicknameMock = vi.fn();
  const auth = { user: null as { nickname: string | null } | null };
  // Same shape as the real one (apps/web/src/lib/api.ts): the dialog shows the server's own pt-BR
  // message on a 409, so a stand-in that swallowed it would make that untestable.
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  }
  return { setNicknameMock, ApiError, auth };
});
vi.mock('../lib/api', () => ({ ApiError }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: auth.user, setNickname: (...a: unknown[]) => setNicknameMock(...a) }) }));

import { NicknameDialog } from './NicknameDialog';

afterEach(() => {
  cleanup();
  setNicknameMock.mockReset();
  auth.user = null;
});

function renderDialog(onSaved = vi.fn()) {
  render(<NicknameDialog open onClose={() => {}} onSaved={onSaved} />);
  return onSaved;
}

function typeNickname(value: string) {
  fireEvent.change(screen.getByLabelText(/apelido/i), { target: { value } });
}

describe('NicknameDialog', () => {
  it('refuses a reserved word client-side, without asking the server', () => {
    renderDialog();
    typeNickname('api');
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    expect(screen.getByText(/reservado/i)).toBeTruthy();
    expect(setNicknameMock).not.toHaveBeenCalled();
  });

  it('refuses a bad shape client-side, without asking the server', () => {
    renderDialog();
    typeNickname('Pe$');
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    expect(screen.getByText(/letras, números ou hífen/i)).toBeTruthy();
    expect(setNicknameMock).not.toHaveBeenCalled();
  });

  it('shows the address the nickname will produce as it is typed', () => {
    renderDialog();
    typeNickname('pedro');

    expect(screen.getByText('termhub.dev/city/@pedro')).toBeTruthy();
  });

  it('surfaces the server 409 as "Esse apelido já é de outra pessoa"', async () => {
    setNicknameMock.mockRejectedValueOnce(new ApiError(409, 'Esse apelido já é de outra pessoa', 'NICKNAME_TAKEN'));
    const onSaved = renderDialog();
    typeNickname('pedro');
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(screen.getByText('Esse apelido já é de outra pessoa')).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('claims the nickname and calls onSaved when the server accepts it', async () => {
    setNicknameMock.mockResolvedValueOnce(undefined);
    const onSaved = renderDialog();
    typeNickname('pedro');
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('pedro'));
    expect(setNicknameMock).toHaveBeenCalledWith('pedro');
  });

  // The server never changes a nickname once set (409 NICKNAME_LOCKED): the dialog must not offer it.
  it('shows a nickname that is already set read-only, with nothing to save', () => {
    auth.user = { nickname: 'alice' };
    renderDialog();

    expect(screen.getByText('termhub.dev/city/@alice')).toBeTruthy();
    expect(screen.queryByLabelText(/apelido/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /salvar/i })).toBeNull();
    expect(screen.getByText(/não pode ser trocado/i)).toBeTruthy();
  });
});
