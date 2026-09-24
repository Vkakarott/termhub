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
import { CreatePinScreen } from './create-pin-screen';

async function typePin(pin: string) {
  for (const digit of pin) {
    // eslint-disable-next-line no-await-in-loop -- sequential presses, each awaited to avoid overlap (see pin-pad.test.tsx)
    await fireEvent.press(screen.getByRole('button', { name: digit }));
  }
}

describe('Criar PIN', () => {
  beforeEach(() => {
    useSessionStore.setState({ phase: 'pin_setup' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls createPin once the same six digits are typed twice', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'createPin').mockResolvedValue(undefined);
    await render(<CreatePinScreen />);
    await typePin('123456');
    await typePin('123456');
    expect(spy).toHaveBeenCalledWith('123456', '123456');
  });

  it('shows a mismatch message and restarts at step 1 without calling createPin', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'createPin').mockResolvedValue(undefined);
    await render(<CreatePinScreen />);
    await typePin('123456');
    await typePin('654321');
    expect(screen.getByText('Os PINs não são iguais')).toBeTruthy();
    expect(screen.getByText('Crie um PIN de 6 dígitos')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});
