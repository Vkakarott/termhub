// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const trackMock = vi.fn();
vi.mock('./analytics', () => ({ track: (...args: unknown[]) => trackMock(...args) }));

const user = { id: 'u1', email: 'a@b.c', name: 'A' };
vi.mock('./api', () => ({
  api: {
    auth: {
      me: vi.fn(async () => ({ user: null, config: {} })),
      login: vi.fn(async () => ({ user })),
      verifyCode: vi.fn(async () => ({ user })),
    },
  },
  ApiError: class ApiError extends Error {},
}));

import { AuthProvider, useAuth } from './auth';

type Auth = ReturnType<typeof useAuth>;
function Probe({ onReady }: { onReady: (auth: Auth) => void }) {
  onReady(useAuth());
  return null;
}

function mount() {
  let auth!: Auth;
  render(
    <AuthProvider>
      <Probe onReady={(a) => (auth = a)} />
    </AuthProvider>,
  );
  return () => auth;
}

afterEach(() => {
  cleanup();
  trackMock.mockReset();
});

describe('AuthProvider analytics', () => {
  it('reports a password login', async () => {
    const auth = mount();
    await act(() => auth().login('a@b.c', 'pw'));
    expect(trackMock).toHaveBeenCalledWith('login', { method: 'password' });
  });

  it('reports an e-mail code login', async () => {
    const auth = mount();
    await act(() => auth().verifyCode('a@b.c', '123456'));
    expect(trackMock).toHaveBeenCalledWith('login', { method: 'code' });
  });
});
