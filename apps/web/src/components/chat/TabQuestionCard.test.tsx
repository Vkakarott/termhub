// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TabQuestionCard } from './TabQuestionCard';
import type { TabQuestion } from '../../lib/types';

afterEach(() => cleanup());

const base = { tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
const colors = { question: 'What is your favorite color?', header: 'Color', multi_select: false, options: [{ label: 'Blue', description: 'Calm and classic.', recommended: true }, { label: 'Green', description: 'Fresh and natural.', recommended: false }, { label: 'Red', description: 'Bold and energetic.', recommended: false }] };
const fruits = { question: 'Which fruits do you like?', header: 'Fruits', multi_select: true, options: [{ label: 'Apple', description: '', recommended: false }, { label: 'Banana', description: '', recommended: false }, { label: 'Mango', description: '', recommended: false }] };
const choice = (over: Partial<TabQuestion> = {}) => ({ ...base, id: 'q1', kind: 'choice', status: 'open', answer: null, payload: { questions: [colors, fruits] }, ...over }) as TabQuestion;
const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, id: 'q2', kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

it('answers a two-question card: a radio on the first tab, checkboxes on the second', () => {
  const onAnswer = vi.fn();
  render(<TabQuestionCard question={choice()} answering={false} onAnswer={onAnswer} />);
  expect(screen.getByText('A aba «api» perguntou')).toBeInTheDocument();
  expect(screen.getByText('Recomendada')).toBeInTheDocument();
  expect(screen.getByText('Calm and classic.')).toBeInTheDocument();
  const submit = screen.getByRole('button', { name: 'Responder' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /Green/ }));
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Mango/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Apple/ }));
  fireEvent.click(submit);
  expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [1] }, { selected: [0, 2] }] });
});

it('"Outra resposta" answers with text and sets the options aside', () => {
  const onAnswer = vi.fn();
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
  expect(screen.queryByRole('tab')).toBeNull(); // one question: no tab strip
  fireEvent.change(screen.getByLabelText('Outra resposta'), { target: { value: '  Purple ' } });
  expect(screen.getByRole('radio', { name: /Blue/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
  expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [], text: 'Purple' }] });
});

it('a permission card shows the live excerpt and allows, denies, or denies with a sentence', async () => {
  const onAnswer = vi.fn();
  const loadScreen = vi.fn(async () => 'Bash command\n  touch probe-file.txt\nDo you want to proceed?');
  render(<TabQuestionCard question={permission()} answering={false} onAnswer={onAnswer} loadScreen={loadScreen} />);
  expect(screen.getByText('A aba «api» pede permissão para usar «Bash»')).toBeInTheDocument();
  // Expanded by default: the tool's name alone does not say what is about to run.
  expect(await screen.findByText(/touch probe-file\.txt/)).toBeVisible();
  expect(screen.getByText('Tela da aba')).toBeInTheDocument();
  expect(loadScreen).toHaveBeenCalledWith('q2');
  fireEvent.click(screen.getByRole('button', { name: 'Permitir' }));
  expect(onAnswer).toHaveBeenLastCalledWith('q2', { allow: true });
  fireEvent.click(screen.getByRole('button', { name: 'Negar' }));
  expect(onAnswer).toHaveBeenLastCalledWith('q2', { allow: false });
  fireEvent.click(screen.getByRole('button', { name: 'Negar e dizer…' }));
  fireEvent.change(screen.getByLabelText('O que dizer à aba'), { target: { value: 'use pnpm' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  expect(onAnswer).toHaveBeenLastCalledWith('q2', { allow: false, text: 'use pnpm' });
});

it('disables every answer while one is in flight', () => {
  render(<TabQuestionCard question={permission()} answering onAnswer={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Permitir' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Negar' })).toBeDisabled();
});

it.each([
  [choice({ status: 'answered', answer: { answers: [{ selected: [1] }, { selected: [0] }] } } as Partial<TabQuestion>), ['What is your favorite color? → Green', 'Respondida']],
  [choice({ status: 'answered_in_tab' }), ['Respondida na aba']],
  [permission({ status: 'expired' }), ['Expirada']],
  [permission({ status: 'failed', error_code: 'MACHINE_OFFLINE', answer: { allow: true } } as Partial<TabQuestion>), ['Permitido', 'Falhou — a máquina está offline']],
])('a closed card is read-only and says how it ended (%#)', (q, texts) => {
  render(<TabQuestionCard question={q} answering={false} onAnswer={vi.fn()} loadScreen={vi.fn(async () => 'x')} />);
  for (const t of texts) expect(screen.getByText(t)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Responder|Permitir/ })).toBeNull();
});

it('shows the error it is given', () => {
  render(<TabQuestionCard question={permission()} answering={false} onAnswer={vi.fn()} error="A pergunta mudou na aba" />);
  expect(screen.getByText('A pergunta mudou na aba')).toBeInTheDocument();
});

it('the question tabs are a real tab list: ids, aria-controls, a labelled panel, only the selected tab in the tab order, arrows move (spec 2026-09-26 §4.12)', () => {
  render(<TabQuestionCard question={choice()} answering={false} onAnswer={vi.fn()} />);
  const [color, fruitsTab] = screen.getAllByRole('tab');
  expect(color).toHaveAttribute('id', 'q1-tab-0');
  expect(color).toHaveAttribute('aria-controls', 'q1-panel');
  expect(color).toHaveAttribute('tabindex', '0');
  expect(fruitsTab).toHaveAttribute('tabindex', '-1');
  const panel = screen.getByRole('tabpanel');
  expect(panel).toHaveAttribute('id', 'q1-panel');
  expect(panel).toHaveAttribute('aria-labelledby', 'q1-tab-0');
  fireEvent.keyDown(color!, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Fruits' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Fruits' })).toHaveFocus();
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'q1-tab-1');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Fruits' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Color' })).toHaveAttribute('aria-selected', 'true'); // wraps
});

it('each option names itself, the recommended one says so, and points at its description', () => {
  render(<TabQuestionCard question={choice()} answering={false} onAnswer={vi.fn()} />);
  expect(screen.getByRole('radio', { name: 'Blue, recomendada' })).toHaveAccessibleDescription('Calm and classic.');
  expect(screen.getByRole('radio', { name: 'Green' })).toHaveAccessibleDescription('Fresh and natural.');
});

it('one question: no tab list and no tab panel role', () => {
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByRole('tabpanel')).toBeNull();
});

const suggestion = { question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [1], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' } };

it('a suggestion pre-selects the option, names its source and enables Responder at once', () => {
  const onAnswer = vi.fn();
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [suggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
  expect(screen.getByRole('radio', { name: /Green/ })).toBeChecked();
  expect(screen.getByText('Sugestão da memória: você respondeu «Green» a «Usar worktree?» em termhub, 20/09/2026')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Responder' })).toBeEnabled();
});

it('a text suggestion fills "Outra resposta"', () => {
  const textSuggestion = { ...suggestion, selected: [], text: 'Usar branch' };
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [textSuggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.getByLabelText('Outra resposta')).toHaveValue('Usar branch');
  expect(screen.getByText('Sugestão da memória: você respondeu «Usar branch» a «Usar worktree?» em termhub, 20/09/2026')).toBeInTheDocument();
});

it('"Esquecer esta decisão" forgets the decision and clears the pre-selection', async () => {
  const onForget = vi.fn(async () => {});
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [suggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} onForget={onForget} />);
  fireEvent.click(screen.getByRole('button', { name: 'Esquecer esta decisão' }));
  expect(onForget).toHaveBeenCalledWith('d1');
  await waitFor(() => expect(screen.queryByText(/Sugestão da memória/)).toBeNull());
  expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked();
});

it("forgetting one question's suggestion keeps another question's pre-selection", async () => {
  const onForget = vi.fn(async () => {});
  const suggestionFruits = { question_index: 1, decision_id: 'd2', similarity: 0.9, selected: [0, 2], source: { question: 'Quais frutas você gosta?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' } };
  render(<TabQuestionCard question={choice({ suggestion: { items: [suggestion, suggestionFruits] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} onForget={onForget} />);
  expect(screen.getByRole('radio', { name: /Green/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Esquecer esta decisão' }));
  expect(onForget).toHaveBeenCalledWith('d1');
  await waitFor(() => expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked());

  // Question 1's own suggestion (a different decision) is untouched by forgetting question 0's.
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits · sugerida' }));
  expect(screen.getByRole('checkbox', { name: /Apple/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Mango/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Banana/ })).not.toBeChecked();
  expect(screen.getByText('Sugestão da memória: você respondeu «Apple, Mango» a «Quais frutas você gosta?» em termhub, 20/09/2026')).toBeInTheDocument();
});

it('several suggested questions: each tab says so, and Responder waits until every one was viewed', () => {
  const onAnswer = vi.fn();
  const suggestionFruits = { question_index: 1, decision_id: 'd2', similarity: 0.99, selected: [0, 2], source: { question: 'Quais frutas você gosta?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' } };
  render(<TabQuestionCard question={choice({ suggestion: { items: [suggestion, suggestionFruits] } } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
  expect(screen.getByRole('tab', { name: 'Color · sugerida' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Fruits · sugerida' })).toBeInTheDocument();
  // Every question is pre-answered, but the second one was never shown: no sending it unseen.
  const submit = screen.getByRole('button', { name: 'Responder' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits · sugerida' }));
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [1] }, { selected: [0, 2] }] });
});

it('a tab without a suggestion carries no mark and does not hold Responder back', () => {
  render(<TabQuestionCard question={choice({ suggestion: { items: [suggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.getByRole('tab', { name: 'Color · sugerida' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Fruits' })).toBeInTheDocument();
  // Fruits has no suggestion, so only an answer to it (not a visit) is missing.
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Apple/ }));
  expect(screen.getByRole('button', { name: 'Responder' })).toBeEnabled();
});

it('an answered card shows no suggestion line', () => {
  render(<TabQuestionCard question={choice({ status: 'answered', answer: { answers: [{ selected: [1] }] }, suggestion: { items: [suggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
});
