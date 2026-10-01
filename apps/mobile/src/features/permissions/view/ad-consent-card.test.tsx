import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));

import { stores } from '../../../../test/helpers/ui-stores';
import { AdConsentCard } from './ad-consent-card';

const store = stores.permissions;
beforeEach(() => store.setState({ adConsent: 'unknown', trackingStatus: 'undetermined' }));

it('asks while consent is unknown, and "Permitir" goes through ATT', async () => {
  await render(<AdConsentCard />);
  expect(screen.getByText('Ajude a medir nossos anúncios')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Permitir')));
  expect(stores.permissionDeps.requestTracking).toHaveBeenCalled();
  expect(store.getState().adConsent).toBe('granted');
  expect(screen.queryByText('Ajude a medir nossos anúncios')).toBeNull();
});

it('"Agora não" declines and hides it', async () => {
  await render(<AdConsentCard />);
  await act(async () => fireEvent.press(screen.getByText('Agora não')));
  expect(store.getState().adConsent).toBe('denied');
  expect(screen.queryByText('Ajude a medir nossos anúncios')).toBeNull();
});

it('stays hidden once decided, or when iOS already refused ATT', async () => {
  store.setState({ adConsent: 'denied' });
  await render(<AdConsentCard />);
  expect(screen.queryByText('Ajude a medir nossos anúncios')).toBeNull();
  await act(async () => store.setState({ adConsent: 'unknown', trackingStatus: 'denied' }));
  expect(screen.queryByText('Ajude a medir nossos anúncios')).toBeNull();
});
