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
import { PinPromptSheet } from './pin-prompt-sheet';

async function typePin(pin: string) {
  for (const digit of pin) {
    // eslint-disable-next-line no-await-in-loop -- sequential presses, each awaited to avoid overlap (see pin-pad.test.tsx)
    await fireEvent.press(screen.getByRole('button', { name: digit }));
  }
}

describe('PinPromptSheet', () => {
  beforeEach(() => {
    useSessionStore.setState({ pinPrompt: { actionId: 'a1' }, error: null, busy: false, biometricsEnabled: false });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('clears the pad after a rejected PIN, shows the error, and allows a second attempt', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'resolvePinPrompt').mockImplementation(async (pin) => {
      if (pin === 'biometrics') return;
      // Mirrors the store's own PIN_INVALID handling: the prompt stays open (same actionId),
      // only `error` changes.
      useSessionStore.setState({ error: 'PIN incorreto.' });
    });
    await render(<PinPromptSheet />);

    await typePin('000000');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('000000');
    expect(screen.getByText('PIN incorreto.')).toBeTruthy();

    // The pad accepted a fresh six digits: it was not stuck at 6/6 after the rejection.
    await typePin('123456');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith('123456');
  });

  it('disables the pad and Cancelar while busy', async () => {
    useSessionStore.setState({ busy: true });
    await render(<PinPromptSheet />);
    expect(screen.getByRole('button', { name: '1' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Cancelar' }).props.accessibilityState.disabled).toBe(true);
  });
});
