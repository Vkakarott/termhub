import { fireEvent, render, screen } from '@testing-library/react-native';
import type { TabSuggestion } from '../model/types';
import { TabSuggestionCard } from './tab-suggestion-card';

const SUGGESTION: TabSuggestion = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null };
const CODEX: TabSuggestion = { ...SUGGESTION, payload: { text: '', context: 'Fiz o merge.\n\nQuer que eu faça o deploy?', agent: 'codex' } };

describe('TabSuggestionCard', () => {
  it('a Claude suggestion keeps its editable text and hint', async () => {
    await render(<TabSuggestionCard suggestion={SUGGESTION} busy={false} onSend={jest.fn()} onDismiss={jest.fn()} />);
    expect(screen.getByText('«api» terminou — o Claude Code sugere:')).toBeTruthy();
    expect(screen.getByText('Não precisa responder.')).toBeTruthy();
    expect(screen.getByDisplayValue('commit it')).toBeTruthy();
  });
  it('a Codex reply card asks for an answer: empty input, Enviar disabled while blank, then sends it', async () => {
    const onSend = jest.fn();
    await render(<TabSuggestionCard suggestion={CODEX} busy={false} onSend={onSend} onDismiss={jest.fn()} />);
    expect(screen.getByText('«api» terminou — o Codex perguntou:')).toBeTruthy();
    expect(screen.getByText('Responda aqui ou na aba.')).toBeTruthy();
    expect(screen.getByText('Quer que eu faça o deploy?')).toBeTruthy();
    const field = screen.getByPlaceholderText('Sua resposta');
    expect(field.props.value).toBe('');
    expect(screen.getByRole('button', { name: 'Enviar' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(field, ' sim ');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(onSend).toHaveBeenCalledWith('s1', 'sim');
  });
});
