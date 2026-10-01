import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));

import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { PushPrimerSheet } from './push-primer-sheet';

const store = stores.permissions;
beforeAll(async () => {
  await enrolStores();
});
beforeEach(() => store.setState({ pushPrimerOpen: true, pushPrimerDismissals: 0, notificationStatus: 'undetermined' }));

it('explains, then asks the OS on "Ativar notificações"', async () => {
  await render(<PushPrimerSheet />);
  expect(screen.getByText('Receba avisos das suas conversas')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Ativar notificações')));
  expect(stores.permissionDeps.requestNotifications).toHaveBeenCalled();
  expect(store.getState().pushPrimerOpen).toBe(false);
});

it('"Agora não" closes it and counts the dismissal', async () => {
  await render(<PushPrimerSheet />);
  await act(async () => fireEvent.press(screen.getByText('Agora não')));
  expect(store.getState()).toMatchObject({ pushPrimerOpen: false, pushPrimerDismissals: 1 });
});

it('stays hidden while the session is locked, and shows again once unlocked', async () => {
  await render(<PushPrimerSheet />);
  expect(screen.getByText('Receba avisos das suas conversas')).toBeTruthy();
  await act(async () => stores.store.setState({ phase: 'locked' }));
  expect(screen.queryByText('Receba avisos das suas conversas')).toBeNull();
  expect(store.getState().pushPrimerOpen).toBe(true);
  await act(async () => stores.store.setState({ phase: 'unlocked' }));
  expect(screen.getByText('Receba avisos das suas conversas')).toBeTruthy();
});

it('stays hidden while the PIN sheet is open, and shows again once it closes', async () => {
  await render(<PushPrimerSheet />);
  await act(async () => stores.store.setState({ pinPrompt: { actionId: 'a1', decision: 'approve' } }));
  expect(screen.queryByText('Receba avisos das suas conversas')).toBeNull();
  await act(async () => stores.store.setState({ pinPrompt: null }));
  expect(screen.getByText('Receba avisos das suas conversas')).toBeTruthy();
});
