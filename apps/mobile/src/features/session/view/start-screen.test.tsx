import { fireEvent, render, screen } from '@testing-library/react-native';

// A real store over the mock transport (latency 0), per the brief: the screen is driven against
// its actual viewmodel, not a hand-written fake.
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
import { StartScreen } from './start-screen';

describe('Início', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls requestDevice with a valid e-mail', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'requestDevice').mockResolvedValue(undefined);
    await render(<StartScreen />);
    await fireEvent.changeText(screen.getByTestId('start-email'), 'pedro@x.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Continuar com e-mail' }));
    expect(spy).toHaveBeenCalledWith('pedro@x.com');
  });

  it('shows the error for an invalid e-mail and calls nothing', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'requestDevice').mockResolvedValue(undefined);
    await render(<StartScreen />);
    await fireEvent.changeText(screen.getByTestId('start-email'), 'not-an-email');
    await fireEvent.press(screen.getByRole('button', { name: 'Continuar com e-mail' }));
    expect(screen.getByText('Digite um e-mail válido')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});
