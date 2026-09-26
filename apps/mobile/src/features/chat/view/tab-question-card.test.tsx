import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { TabQuestion, TabQuestionSuggestion } from '../model/types';
import { TabQuestionCard } from './tab-question-card';

const SUGGESTION: TabQuestionSuggestion = {
  items: [{ question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [1], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }],
};

const BASE_QUESTION: TabQuestion = {
  id: 'q1',
  tab_id: 't-api',
  tab_name: 'api',
  kind: 'choice',
  status: 'open',
  error_code: null,
  created_at: new Date().toISOString(),
  answered_at: null,
  closed_at: null,
  answer: null,
  payload: {
    questions: [
      {
        question: 'Usar worktree?',
        header: 'Worktree',
        multi_select: false,
        options: [
          { label: 'Sim', description: '', recommended: false },
          { label: 'Não', description: '', recommended: false },
        ],
      },
    ],
  },
};

describe('TabQuestionCard: suggested answer (chat decision memory spec 2026-09-26 §5.1)', () => {
  it('pre-selects the suggested option and shows "Sugestão da memória"', async () => {
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: SUGGESTION }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Sim' }).props.accessibilityState.checked).toBe(false);
    expect(screen.getByText('Sugestão da memória: você respondeu «Não» a «Usar worktree?» em termhub, 20/09/2026')).toBeTruthy();
  });

  it('a text suggestion fills "Outra resposta" instead of pre-selecting an option', async () => {
    const textSuggestion: TabQuestionSuggestion = { items: [{ ...SUGGESTION.items[0]!, selected: [], text: 'Os dois' }] };
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: textSuggestion }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByLabelText('Outra resposta').props.value).toBe('Os dois');
    expect(screen.getByText('Sugestão da memória: você respondeu «Os dois» a «Usar worktree?» em termhub, 20/09/2026')).toBeTruthy();
  });

  it('"Esquecer esta decisão" calls onForget(decisionId) and clears the pre-selection', async () => {
    const onForget = jest.fn(async () => undefined);
    const onAnswer = jest.fn();
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: SUGGESTION }} busy={false} onAnswer={onAnswer} loadScreen={async () => null} onForget={onForget} />);

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Esquecer esta decisão' })));
    expect(onForget).toHaveBeenCalledWith('d1');
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(false);

    // Nothing is answered on its own: "Responder" still needs its own press.
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('no suggestion line renders for a question with no suggestion, or once it is answered', async () => {
    await render(<TabQuestionCard question={BASE_QUESTION} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esquecer esta decisão' })).toBeNull();
  });

  it('an answered/closed card shows no suggestion line even if `suggestion` is still on the payload', async () => {
    const closed: TabQuestion = { ...BASE_QUESTION, suggestion: SUGGESTION, status: 'answered', answer: { answers: [{ selected: [1] }] } };
    await render(<TabQuestionCard question={closed} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esquecer esta decisão' })).toBeNull();
  });
});
