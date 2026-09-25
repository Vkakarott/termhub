import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => {
  const { createSessionStore } = require('@/features/session/viewmodel/createSessionStore');
  const { createHttpMobileApi } = require('@/services/api/client');
  const { createMockTransport } = require('@/services/api/mock');
  const { SoftwareDeviceKey } = require('@/services/key/software');
  const { vault } = require('@/services/vault');
  const transport = createMockTransport({ latency: [0, 0] });
  const key = new SoftwareDeviceKey();
  const api = createHttpMobileApi({ transport, baseUrl: 'https://termhub.dev', app: 'ios/0.1.0+1', key, onTokenExpired: async () => null });
  return { useSessionStore: createSessionStore({ api, key, vault, mockControls: transport.controls }) };
});

import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { WaitingScreen } from './waiting-screen';

const REQUEST = { id: 'req1', code: 'K7F2QD', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
// The real controls the store was built with (see the mock above): kept so a test can restore
// them after the "without mockControls" case sets the field to null.
const REAL_CONTROLS = useSessionStore.getState().mockControls;

describe('Aguardando', () => {
  beforeEach(() => {
    useSessionStore.setState({ phase: 'waiting', request: REQUEST, mockControls: REAL_CONTROLS });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows the formatted code, the countdown and the simulation buttons when mockControls is set', async () => {
    const approve = jest.spyOn(REAL_CONTROLS!, 'approve').mockImplementation(() => undefined);
    const deny = jest.spyOn(REAL_CONTROLS!, 'deny').mockImplementation(() => undefined);
    await render(<WaitingScreen />);

    expect(screen.getByText('K7F-2QD')).toBeTruthy();
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Simular aprovação na web' }));
    expect(approve).toHaveBeenCalledWith('req1');
    await fireEvent.press(screen.getByRole('button', { name: 'Simular recusa' }));
    expect(deny).toHaveBeenCalledWith('req1');
  });

  it('hides the simulation buttons when mockControls is absent', async () => {
    useSessionStore.setState({ mockControls: null });
    await render(<WaitingScreen />);

    expect(screen.queryByRole('button', { name: 'Simular aprovação na web' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Simular recusa' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
  });

  it('cancels the request', async () => {
    await render(<WaitingScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar' }));
    expect(useSessionStore.getState().phase).toBe('new');
    expect(useSessionStore.getState().request).toBeNull();
  });
});
