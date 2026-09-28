import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat-grants/viewmodel/useChatGrantsStore', () => ({ useChatGrantsStore: require('../../../../test/helpers/ui-stores').stores.chatGrants }));

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ChatGrantsScreen } from './chat-grants-screen';

const LOAD = { timeout: 15_000 };

const ACTIVE = {
  kind: 'tab' as const,
  id: 'g1',
  tab_id: 't-api',
  tool: 'send_input',
  source_action_id: null,
  created_at: '2026-09-25T10:00:00.000Z',
  expires_at: '2099-01-01T00:00:00.000Z',
  tab_name: 'api',
  project_id: 'p-termhub',
  project_name: 'termhub',
  conversation_id: 'c1',
  conversation_project_name: null,
  conversation_archived: false,
  state: 'active' as const,
  ended_at: null,
  scope: null,
  standing_kind: null,
};

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});

describe('Permissões do chat', () => {
  it('titles the screen and says so when nothing is active and the history is empty', async () => {
    await render(<ChatGrantsScreen />);
    expect(screen.getByText('Permissões do chat')).toBeTruthy();
    expect(await screen.findByText('Nenhuma permissão ativa agora.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Nada no histórico ainda.')).toBeTruthy();
  });

  it('renders a project grant row, named by its project, next to a tab row', async () => {
    const projectRow = {
      kind: 'project' as const,
      id: 'pg1',
      tab_id: null,
      tool: null,
      source_action_id: null,
      created_at: '2026-09-25T11:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
      tab_name: null,
      project_id: 'p-termhub',
      project_name: 'termhub',
      conversation_id: 'c1',
      conversation_project_name: null,
      conversation_archived: false,
      state: 'active' as const,
      ended_at: null,
      scope: 'board' as const,
      standing_kind: null,
    };
    jest.spyOn(stores.api, 'listGrants').mockImplementation(async (_a, q) => (q.state === 'active' ? { grants: [projectRow, ACTIVE], next_cursor: null } : { grants: [], next_cursor: null }));
    await render(<ChatGrantsScreen />);
    expect(await screen.findByText('Quadro do projeto termhub', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Aba api · termhub')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Revogar' })).toHaveLength(2);
  });

  it('says how long each kind of permission lasts (TER-386)', async () => {
    await render(<ChatGrantsScreen />);
    expect(screen.getByText('O que o chat pode fazer sem pedir confirmação. Permissões de conversa valem por até 24 horas; as sem prazo valem até você revogar.')).toBeTruthy();
    await waitFor(() => expect(stores.chatGrants.getState().loading).toBe(false), LOAD);
  });

  it('renders a standing row by its kind and project, "sem prazo", with Revogar (TER-386)', async () => {
    const standingRow = {
      ...ACTIVE,
      kind: 'standing' as const,
      id: 'sg1',
      tab_id: null,
      tool: null,
      tab_name: null,
      expires_at: null,
      conversation_id: null,
      standing_kind: 'close_tab' as const,
    };
    jest.spyOn(stores.api, 'listGrants').mockImplementation(async (_a, q) => (q.state === 'active' ? { grants: [standingRow], next_cursor: null } : { grants: [], next_cursor: null }));
    const revoke = jest.spyOn(stores.api, 'revokeGrant').mockResolvedValue(undefined);
    await render(<ChatGrantsScreen />);
    expect(await screen.findByText('Fechar abas paradas no projeto termhub · sem prazo', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Chat geral · sem prazo')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(revoke).toHaveBeenCalledWith(expect.anything(), 'sg1');
    await waitFor(() => expect(stores.chatGrants.getState()).toMatchObject({ revokingId: null, loading: false }), LOAD);
  });

  it('shows an active grant with its origin and revokes it without a PIN', async () => {
    jest
      .spyOn(stores.api, 'listGrants')
      .mockImplementation(async (_a, q) => (q.state === 'active' ? { grants: [ACTIVE], next_cursor: null } : { grants: [], next_cursor: null }));
    const revoke = jest.spyOn(stores.api, 'revokeGrant').mockResolvedValue(undefined);
    await render(<ChatGrantsScreen />);
    expect(await screen.findByText('Aba api · termhub', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText(/^Chat geral · até/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(revoke).toHaveBeenCalledWith(expect.anything(), 'g1');
    expect(stores.store.getState().pinPrompt).toBeNull();
    // The revoke reloads the list; let it settle before the next test.
    await waitFor(() => expect(stores.chatGrants.getState()).toMatchObject({ revokingId: null, loading: false }), LOAD);
  });

  it('Voltar goes back', async () => {
    await render(<ChatGrantsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockRouter.back).toHaveBeenCalled();
    await waitFor(() => expect(stores.chatGrants.getState().loading).toBe(false), LOAD);
  });
});
