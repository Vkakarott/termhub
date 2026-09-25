import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/notifications/viewmodel/useNotificationsStore', () => ({
  useNotificationsStore: require('../../../../test/helpers/ui-stores').stores.notifications,
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useFocusEffect: (cb: () => void) => {
    require('react').useEffect(cb, [cb]);
  },
}));

import { useNotificationsStore } from '@/features/notifications/viewmodel/useNotificationsStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { NotificationsScreen } from './notifications-screen';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  useNotificationsStore.setState({ items: [], unread: 0, loading: false, loadingMore: false, nextBefore: null, error: null });
});

afterEach(() => {
  mockPush.mockClear();
  jest.restoreAllMocks();
});

describe('Notificações', () => {
  it('lists title, body and the relative time, loading on focus', async () => {
    const load = jest.spyOn(stores.api, 'notifications');
    await render(<NotificationsScreen />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('termhub precisa de você', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText(/aba api \(jarvis\)/)).toBeTruthy();
  });

  it('tapping a row marks it read and navigates to the chat of its project', async () => {
    await render(<NotificationsScreen />);
    const row = await screen.findByRole('button', { name: 'termhub precisa de você' }, LOAD);
    await act(async () => fireEvent.press(row));

    expect(mockPush).toHaveBeenCalledWith('/chat/p-termhub');
    const item = useNotificationsStore.getState().items.find((r) => r.data.action_id === 'a-termhub-1');
    expect(item?.read_at).not.toBeNull();
  });

  it('a row with no project_id navigates to the general chat', async () => {
    await render(<NotificationsScreen />);
    await screen.findByText('termhub precisa de você', undefined, LOAD); // the initial load() settled

    await act(async () =>
      useNotificationsStore.setState({
        items: [{ id: 'n1', kind: 'reply', title: 'Resposta pronta', body: 'O chat geral terminou de responder.', data: {}, created_at: new Date().toISOString(), read_at: null }],
        unread: 1,
      }),
    );
    const row = await screen.findByRole('button', { name: 'Resposta pronta' }, LOAD);
    await act(async () => fireEvent.press(row));

    expect(mockPush).toHaveBeenCalledWith('/chat/general');
  });
});
