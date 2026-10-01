import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));

import { stores } from '../../../../test/helpers/ui-stores';
import { PushPrimerSheet } from './push-primer-sheet';

const store = stores.permissions;
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
