import { render, screen } from '@testing-library/react-native';
import type { ChatMessage } from '../model/types';
import { MessageBubble } from './message-bubble';

const answer = (over: Partial<ChatMessage>): ChatMessage =>
  ({ id: 'm1', conversation_id: 'c1', role: 'assistant', text: '', usage: null, error_code: null, created_at: '2026-09-30T06:00:00.000Z', ...over }) as ChatMessage;

// TER-588: the usage limit, and the account that took over, read the same as on the web.
describe('MessageBubble notices', () => {
  it('says the account hit its usage limit instead of the generic failure', async () => {
    await render(<MessageBubble message={answer({ error_code: 'USAGE_LIMIT', notice: { kind: 'usage_limit', account: 'Pessoal', resets_at: null, fallback: 'auto_swap_off' } })} streamed={undefined} started={false} />);
    expect(screen.getByText('A conta "Pessoal" do Claude atingiu o limite de uso. A troca automática está desligada nesta máquina.')).toBeTruthy();
    expect(screen.queryByText(/parou no meio/)).toBeNull();
  });

  it('says which account took over above the answer it gave', async () => {
    await render(<MessageBubble message={answer({ text: 'oi!', notice: { kind: 'account_swap', from: null, to: 'Trabalho', resets_at: null } })} streamed={undefined} started />);
    expect(screen.getByText('A conta padrão do Claude desta máquina atingiu o limite de uso; a conta "Trabalho" assumiu esta resposta.')).toBeTruthy();
  });
});
