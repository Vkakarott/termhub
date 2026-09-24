import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/settings/viewmodel/useSettingsStore', () => ({ useSettingsStore: require('../../../../test/helpers/ui-stores').stores.settings }));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { useThemeStore } from '@/features/theme/viewmodel/useThemeStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { SettingsScreen } from './settings-screen';

const LOAD = { timeout: 5000 };

/** Not `jest.spyOn(getState(), …)`: zustand replaces the state object on every `setState`, so a
 * restored spy would linger on the new one (same reason `conversation-screen.test.tsx` uses it). */
const realSessionActions = { ...stores.store.getState() };

beforeAll(async () => {
  await enrolStores();
  await stores.chat.getState().open(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  useSessionStore.setState({
    error: null,
    enableBiometrics: realSessionActions.enableBiometrics,
    disableBiometrics: realSessionActions.disableBiometrics,
    leave: realSessionActions.leave,
    biometricsEnabled: false,
  });
  useThemeStore.setState({ theme: 'system' });
});

describe('Ajustes', () => {
  it('shows this device, once loaded', async () => {
    await render(<SettingsScreen />);
    expect(await screen.findByText('iPhone de teste', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText(/iPhone15,2/)).toBeTruthy();
  });

  it('the biometrics switch calls enableBiometrics / disableBiometrics', async () => {
    const enable = jest.fn(async () => true);
    const disable = jest.fn(async () => undefined);
    useSessionStore.setState({ enableBiometrics: enable, disableBiometrics: disable, biometricsEnabled: false });
    await render(<SettingsScreen />);

    const toggle = await screen.findByRole('switch', {}, LOAD);
    await act(async () => fireEvent(toggle, 'valueChange', true));
    expect(enable).toHaveBeenCalledTimes(1);

    await act(async () => useSessionStore.setState({ biometricsEnabled: true }));
    await act(async () => fireEvent(toggle, 'valueChange', false));
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it('the theme buttons call setTheme', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Escuro' }, LOAD));
    expect(useThemeStore.getState().theme).toBe('dark');
    await fireEvent.press(screen.getByRole('button', { name: 'Claro' }));
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('"Sair e remover este aparelho" asks first, then calls leave()', async () => {
    const leave = jest.fn(async () => undefined);
    useSessionStore.setState({ leave });
    await render(<SettingsScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Sair e remover este aparelho' }, LOAD));
    expect(leave).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Remover' }));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('shows the general chat host line and the mock server mode', async () => {
    await render(<SettingsScreen />);
    const host = useChatStore.getState().conversations['']?.host;
    if (!host) throw new Error('expected the general chat host to be loaded');
    expect(screen.getByText(new RegExp(host.kind === 'ready' ? host.machine.name : ''))).toBeTruthy();
    expect(screen.getByText(stores.api.mode === 'http' ? 'Servidor: termhub.dev' : 'Servidor: mock')).toBeTruthy();
  });

  it('runs the key diagnostic and shows every step ok', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Testar a chave do aparelho' }, LOAD));
    expect(await screen.findByText('create: ok', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('destroy: ok')).toBeTruthy();
  });
});
