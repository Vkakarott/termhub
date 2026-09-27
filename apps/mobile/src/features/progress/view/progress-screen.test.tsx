import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/progress/viewmodel/useProgressStore', () => ({ useProgressStore: require('../../../../test/helpers/ui-stores').stores.progress }));
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    require('react').useEffect(cb, [cb]);
  },
}));

import { useProgressStore } from '@/features/progress/viewmodel/useProgressStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ProgressScreen } from './progress-screen';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});
beforeEach(() => {
  useProgressStore.setState({ epics: [], loading: false, error: null });
});
afterEach(() => {
  useProgressStore.getState().stopPolling();
  jest.restoreAllMocks();
});

describe('Progresso', () => {
  it('loads on focus and shows the epic, its percent and who waits for the user', async () => {
    const load = jest.spyOn(stores.api, 'progress');
    await render(<ProgressScreen />);
    expect(load).toHaveBeenCalled();
    expect(await screen.findByText('Visão gerencial', {}, LOAD)).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('1 agente esperando você')).toBeTruthy();
  });

  it('expands an epic to its cards and agents', async () => {
    await render(<ProgressScreen />);
    const title = await screen.findByText('Visão gerencial', {}, LOAD);
    await act(async () => fireEvent.press(title));
    expect(screen.getByText('TER-183 Painel de progresso')).toBeTruthy();
    expect(screen.getByText(/api · esperando você/)).toBeTruthy();
    expect(screen.getAllByText('~20–45 min de trabalho').length).toBeGreaterThan(0);
  });

  it('shows the empty state', async () => {
    jest.spyOn(stores.api, 'progress').mockResolvedValue({ epics: [], generated_at: '' });
    await render(<ProgressScreen />);
    expect(await screen.findByText('Nenhum épico em andamento', {}, LOAD)).toBeTruthy();
  });
});
