import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));

let mockId = 'p-termhub';
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ id: mockId }),
  Link: ({ children }: { children: unknown }) => children,
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import type { TChatEvent, TChatMessage } from '@/services/api/contract';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ConversationScreen } from './conversation-screen';

const SEEDED_USER = 'Como estão as abas do projeto?';
const SEEDED_ASSISTANT = 'A aba api está esperando sua confirmação pra rodar `npm test`.';

function assistantRow(id: string, extra: Partial<TChatMessage> = {}): TChatMessage {
  return { id, conversation_id: 'c-termhub', role: 'assistant', text: '', usage: null, error_code: null, created_at: new Date().toISOString(), ...extra };
}

function delta(messageId: string, text: string): TChatEvent {
  return { type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: messageId, delta: text };
}

/** Appends rows to the open project's thread, as the socket's events would. */
function addRows(rows: TChatMessage[], live: TChatEvent[]) {
  const s = useChatStore.getState();
  const slot = s.conversations['p-termhub']!;
  useChatStore.setState({ conversations: { ...s.conversations, 'p-termhub': { ...slot, messages: [...slot.messages, ...rows] } }, live });
}

/** Replaces one of the store's actions for a test. Not `jest.spyOn(getState(), …)`: zustand
 * replaces the state object on every `setState`, so a restored spy would linger on the new one. */
const realActions = { ...stores.chat.getState() };
function stubAction<K extends 'decide' | 'reset' | 'setHost'>(name: K) {
  const fn = jest.fn(async () => undefined);
  useChatStore.setState({ [name]: fn } as Partial<ReturnType<typeof useChatStore.getState>>);
  return fn;
}

/** The first load of a file signs its first P-256 proof, slow while other suites share the CPU. */
const LOAD = { timeout: 5000 };

beforeAll(async () => {
  await enrolStores();
  await stores.chat.getState().loadProjects();
});

beforeEach(() => {
  mockId = 'p-termhub';
  // The screens are under test here, not the socket (the store's own tests cover it): no events.
  jest.spyOn(stores.api, 'events').mockReturnValue(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  useChatStore.setState({ error: null, live: [], decide: realActions.decide, reset: realActions.reset, setHost: realActions.setHost });
});

describe('Conversa', () => {
  it('renders the thread: the person in plain text, the assistant as markdown, the title and the host line', async () => {
    await render(<ConversationScreen />);
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
    const markdown = screen.getAllByTestId('markdown').map((node) => node.props.children);
    expect(markdown).toContain(SEEDED_ASSISTANT);
    expect(markdown).not.toContain(SEEDED_USER);
    expect(screen.getByText('termhub')).toBeTruthy();
    expect(screen.getByText('Esta conversa roda na máquina jarvis, na conta padrão do Claude dela.')).toBeTruthy();
    // A project's host is fixed: only the account-wide chat offers the picker.
    expect(screen.queryByRole('button', { name: 'Trocar máquina ou conta' })).toBeNull();
  });

  it('shows a streaming bubble with the folded deltas, "pensando…" for a started empty row, and a failure sentence', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    const thinking = assistantRow('m-think');
    await act(() =>
      addRows(
        [assistantRow('m-stream'), thinking, assistantRow('m-failed', { error_code: 'HOST_GONE' })],
        [delta('m-stream', 'Rodei `npm'), delta('m-stream', ' test` no jarvis'), { type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: thinking }],
      ),
    );

    expect(screen.getByText('Rodei `npm test` no jarvis')).toBeTruthy();
    expect(screen.getByText('pensando…')).toBeTruthy();
    expect(screen.getByText('A máquina do chat saiu do ar no meio da resposta. Ligue-a e mande a mensagem de novo.')).toBeTruthy();
  });

  it('a new delta re-renders only the streaming bubble, not the rest of the thread', async () => {
    const { renders } = jest.requireMock('react-native-markdown-display') as { renders: unknown[] };
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    await act(() => addRows([assistantRow('m-stream')], [delta('m-stream', 'Rodei')]));

    renders.length = 0;
    await act(() => useChatStore.setState({ live: [delta('m-stream', 'Rodei'), delta('m-stream', ' os testes')] }));
    expect(screen.getByText('Rodei os testes')).toBeTruthy();
    expect(renders).toEqual(['Rodei os testes']);
  });

  it('renders the pending action card; Autorizar calls decide(id, approve)', async () => {
    const decide = stubAction('decide');
    await render(<ConversationScreen />);
    expect(await screen.findByText('digitar `npm test` na aba api do projeto termhub, no jarvis', undefined, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recusar' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Autorizar' }));
    expect(decide).toHaveBeenCalledWith('a-termhub-1', 'approve');
  });

  it('Autorizar opens the PIN sheet', async () => {
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Autorizar' }, LOAD));
    expect(useSessionStore.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1' });
    await act(() => useSessionStore.getState().cancelPinPrompt());
    expect(useChatStore.getState().decidingId).toBeNull();
  });

  it('the composer sends on the button and clears; the mic is disabled with "em breve"', async () => {
    const sent = jest.spyOn(stores.api, 'sendMessage').mockResolvedValue({ conversation_id: 'c-termhub', user_message_id: 'u', assistant_message_id: 'a' });
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    const send = screen.getByRole('button', { name: 'Enviar' });
    expect(send.props.accessibilityState.disabled).toBe(true);
    const mic = screen.getByRole('button', { name: /em breve/ });
    expect(mic.props.accessibilityState.disabled).toBe(true);
    expect(within(mic).getByText('em breve')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'como está o deploy?');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'como está o deploy?', project_id: 'p-termhub' });
    expect(screen.getByLabelText('Mensagem').props.value).toBe('');
  });

  it('Nova conversa asks first, then resets', async () => {
    const reset = stubAction('reset');
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Nova conversa' }, LOAD));
    expect(reset).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Começar nova conversa' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('the account-wide chat offers the host sheet, which sets the machine and account', async () => {
    mockId = 'general';
    const setHost = stubAction('setHost');
    await render(<ConversationScreen />);
    expect(await screen.findByText('Chat geral', undefined, LOAD)).toBeTruthy();

    await fireEvent.press(await screen.findByRole('button', { name: 'Trocar máquina ou conta' }, LOAD));
    expect(await screen.findByText('hulk', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('offline')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Claude Pedro (jarvis)' }));
    expect(setHost).toHaveBeenCalledWith('m-jarvis', 'acc-1');
  });

  it('an unknown route opens the account-wide chat and says the conversation was not found', async () => {
    mockId = 'c-nowhere';
    await render(<ConversationScreen />);
    expect(await screen.findByText('Conversa não encontrada.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Chat geral')).toBeTruthy();
  });
});
