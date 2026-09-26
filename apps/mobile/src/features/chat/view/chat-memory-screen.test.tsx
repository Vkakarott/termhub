import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatMemoryStore', () => ({ useChatMemoryStore: require('../../../../test/helpers/ui-stores').stores.chatMemory }));

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

import type { TChatDecision, TDecisionsResponse } from '@/services/api/contract';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { useChatMemoryStore } from '../viewmodel/useChatMemoryStore';
import { ChatMemoryScreen } from './chat-memory-screen';

/** The first load of a file signs its first P-256 proof, slow while other suites share the CPU. */
const LOAD = { timeout: 15_000 };

function dec(over: Partial<TChatDecision> & { id: string; question: string }): TChatDecision {
  return {
    project_id: null,
    project_name: null,
    header: 'H',
    options: [],
    multi_select: false,
    answer: { labels: ['Sim'] },
    suggested_count: 1,
    accepted_count: 1,
    created_at: new Date().toISOString(),
    ...over,
  };
}

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
  // Every test starts from a clean slate: the store is a singleton shared across this file's tests.
  useChatMemoryStore.setState({ memory: null, decisions: null, cursor: null, q: '', loadingMore: false, switching: false, forgettingId: null, error: null });
});

describe('Memória do chat', () => {
  it('lists the remembered decisions: question, answer, project and counts', async () => {
    await render(<ChatMemoryScreen />);
    expect(await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('→ Não')).toBeTruthy();
    expect(screen.getByText(/termhub · .+ · sugerida 3× · aceita 2×/)).toBeTruthy();
    // A free-text answer shows the text, not an empty label list.
    expect(screen.getByText('Qual branch a partir de main?')).toBeTruthy();
    expect(screen.getByText('→ fix/city-sound-ios')).toBeTruthy();
  });

  it('typing in "Buscar" re-queries with q, debounced', async () => {
    // Real timers throughout (the debounce is only ~300ms, well under `LOAD`'s own timeout):
    // toggling jest's fake timers mid-test, with a real async store already in flight over the
    // mock transport, is fragile here and buys nothing a longer `findBy` wait doesn't already give.
    const spy = jest.spyOn(stores.api, 'chatDecisions');
    await render(<ChatMemoryScreen />);
    await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD);
    spy.mockClear();

    await fireEvent.changeText(screen.getByTestId('chat-memory-search'), 'branch');
    // Both fixtures show at first (unfiltered): "Qual branch…" is on screen either way, so only the
    // *disappearance* of the other row proves the debounced, filtered re-query actually landed.
    await waitFor(() => expect(screen.queryByText('Usar worktree para essa tarefa?')).toBeNull(), LOAD);
    expect(screen.getByText('Qual branch a partir de main?')).toBeTruthy();
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), 'branch');
  });

  it('"Esquecer" asks a native confirm and removes the row once the DELETE resolves', async () => {
    // `mockResolvedValue`, not a call-through spy: this file's mock backend is shared across every
    // test below, and a real DELETE would remove the seeded fixture for good.
    const forget = jest.spyOn(stores.api, 'forgetChatDecision').mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await render(<ChatMemoryScreen />);
    await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD);

    // Decisions list newest first: `d-branch` (6h ago) is the first row, `d-worktree` (2 days ago) the second.
    await act(async () => fireEvent.press(screen.getAllByRole('button', { name: 'Esquecer' })[0]!));
    expect(alert).toHaveBeenCalled();
    await waitFor(() => expect(forget).toHaveBeenCalledWith(expect.anything(), 'd-branch'), LOAD);
    await waitFor(() => expect(screen.queryByText('Qual branch a partir de main?')).toBeNull(), LOAD);
    expect(screen.getByText('Usar worktree para essa tarefa?')).toBeTruthy(); // the other row stays
  });

  it('the switch calls setChatMemory(false)', async () => {
    // `mockResolvedValue`, not a call-through spy: a real PATCH would flip the shared mock
    // backend's switch for every test that runs after this one in the file.
    const spy = jest.spyOn(stores.api, 'setChatMemory').mockResolvedValue({ enabled: false, available: true, count: 2 });
    await render(<ChatMemoryScreen />);
    const toggle = await screen.findByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' }, LOAD);
    await act(async () => fireEvent(toggle, 'valueChange', false));
    expect(spy).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('available: false hides the switch and shows "Sugestões indisponíveis neste servidor"', async () => {
    await render(<ChatMemoryScreen />);
    await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD);
    await act(async () => useChatMemoryStore.setState((s) => ({ memory: s.memory ? { ...s.memory, available: false } : s.memory })));
    expect(screen.getByText('Sugestões indisponíveis neste servidor')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('"Carregar mais" appears with a next_cursor and appends the next page', async () => {
    const page1: TDecisionsResponse = { decisions: [dec({ id: 'd1', question: 'Primeira pergunta?' })], next_cursor: 'c2' };
    const page2: TDecisionsResponse = { decisions: [dec({ id: 'd2', question: 'Segunda pergunta?' })], next_cursor: null };
    jest.spyOn(stores.api, 'chatDecisions').mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    await render(<ChatMemoryScreen />);
    expect(await screen.findByText('Primeira pergunta?', undefined, LOAD)).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Carregar mais' })));
    expect(await screen.findByText('Segunda pergunta?', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Primeira pergunta?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });

  it('"Voltar" goes back', async () => {
    await render(<ChatMemoryScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Voltar' }, LOAD));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});
