import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
// The conversation pane's microphone: never records here.
jest.mock('@/features/chat/viewmodel/use-voice', () => ({
  useVoice: () => ({ state: 'idle', seconds: 0, error: null, notice: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
  useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(async () => undefined), stop: jest.fn(async () => null), cancel: jest.fn() }),
}));

/** The window the screen sees: an iPad in landscape unless a test resizes it. */
const mockWindow = { width: 1024, height: 768, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

const mockPush = jest.fn();
let mockFocus: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useFocusEffect: (cb: () => void) => {
    require('react').useEffect(() => {
      mockFocus = cb;
      cb();
    }, [cb]);
  },
  useLocalSearchParams: () => ({}),
  Link: ({ children }: { children: unknown }) => children,
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { enrolStores } from '../../../../test/helpers/ui-stores';
import { ChatsScreen } from './chats-screen';

const LOAD = { timeout: 15_000 };
/** The seeded `p-termhub` thread's first message (mock fixtures). */
const SEEDED_USER = 'Como estão as abas do projeto?';

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  mockWindow.width = 1024;
  mockWindow.height = 768;
  mockPush.mockClear();
});

describe('Chats on a wide window (iPad, spec 2026-09-28 §2.3)', () => {
  it('shows the list and, until one is chosen, an empty pane', async () => {
    await render(<ChatsScreen />);
    expect(await screen.findByText('termhub', undefined, LOAD)).toBeTruthy();
    expect(screen.getByTestId('chats-list-pane')).toBeTruthy();
    expect(screen.getByText('Escolha uma conversa')).toBeTruthy();
  });

  it('opens a chat in the pane next to the list, not as a pushed screen', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Voltar' })).toBeNull();
    expect(screen.getByRole('button', { name: /^termhub/ }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.queryByText('Escolha uma conversa')).toBeNull();
  });

  it('collapses to the list when the window narrows, and brings the chat back when it widens', async () => {
    const view = await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    mockWindow.width = 390; // Slide Over / a narrow Split View
    await view.rerender(<ChatsScreen />);
    expect(screen.queryByTestId('chats-detail-pane')).toBeNull();
    expect(screen.queryByText(SEEDED_USER)).toBeNull();
    // Compact again: a tap pushes, as on a phone.
    await fireEvent.press(screen.getByRole('button', { name: /^Chat geral/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/general');

    mockWindow.width = 1024;
    await view.rerender(<ChatsScreen />);
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
  });

  it('re-opens its own chat when the tab regains focus after a pushed one took over the store', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    // A notification tap pushed the account-wide chat, which became the store's active one.
    await act(() => useChatStore.getState().openByRoute('general'));
    expect(useChatStore.getState().activeProject).toBeNull();

    await act(async () => mockFocus?.());
    expect(useChatStore.getState().activeProject).toBe('p-termhub');
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
  });
});
