import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  Link: ({ children }: { children: unknown }) => children,
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { enrolStores } from '../../../../test/helpers/ui-stores';
import { ChatsScreen } from './chats-screen';

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  mockPush.mockClear();
  jest.restoreAllMocks();
});

describe('Chats', () => {
  it('lists Chat geral and the three projects, with "respondendo…" when busy and the pending badge', async () => {
    await render(<ChatsScreen />);
    expect(await screen.findByText('termhub')).toBeTruthy();
    expect(screen.getByText('Chat geral')).toBeTruthy();
    expect(screen.getByText('opapingou')).toBeTruthy();
    expect(screen.getByText('reactivando')).toBeTruthy();
    expect(screen.getByLabelText('1 confirmação pendente')).toBeTruthy();
    expect(screen.queryByText('respondendo…')).toBeNull();

    // The mock's own busy window closes within a tick; set it directly.
    const projects = useChatStore.getState().projects.map((p) => (p.id === 'p-opapingou' ? { ...p, busy: true } : p));
    await act(() => useChatStore.setState({ projects }));
    expect(await screen.findByText('respondendo…')).toBeTruthy();
  });

  it('opens the account-wide chat and a project by route', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Chat geral/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/general');
    await fireEvent.press(screen.getByRole('button', { name: /^termhub/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/p-termhub');
  });
});
