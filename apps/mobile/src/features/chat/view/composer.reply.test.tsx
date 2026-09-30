import { fireEvent, render, screen } from '@testing-library/react-native';
import { TextInput } from 'react-native';
import type { TChatAttachment } from '@/services/api/contract';
import { Composer } from './composer';

const mockVoice = { state: 'idle' as import('../viewmodel/use-voice').VoiceState, seconds: 0, error: null as string | null, notice: null as string | null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() };
jest.mock('../viewmodel/use-voice', () => ({ useVoice: () => mockVoice, useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }) }));

const props = () => ({
  sending: false,
  onSend: jest.fn(async () => true),
  uploadAttachment: jest.fn(async () => ({}) as TChatAttachment),
  deleteAttachment: jest.fn(async () => undefined),
});

describe('Composer: answering a message (TER-447)', () => {
  it('shows who and what is being answered, and ✕ cancels', async () => {
    const onCancelReply = jest.fn();
    await render(<Composer {...props()} replyTo={{ id: 'm1', role: 'assistant', excerpt: 'Abri a aba build' }} onCancelReply={onCancelReply} />);
    expect(screen.getByText('Respondendo a Concierge')).toBeTruthy();
    expect(screen.getByText('Abri a aba build')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Cancelar resposta'));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  it('says "Respondendo a você" for the person\'s own message, and shows nothing without a reply', async () => {
    const p = props();
    await render(<Composer {...p} replyTo={{ id: 'm2', role: 'user', excerpt: 'sobe o deploy' }} />);
    expect(screen.getByText('Respondendo a você')).toBeTruthy();
    await screen.rerender(<Composer {...p} replyTo={null} />);
    expect(screen.queryByLabelText('Cancelar resposta')).toBeNull();
  });

  it('focuses the box when a reply starts', async () => {
    const p = props();
    const focus = jest.spyOn(TextInput.prototype, 'focus');
    await render(<Composer {...p} replyTo={null} />);
    // The test renderer may focus on mount; what matters is the focus the reply itself asks for.
    const before = focus.mock.calls.length;
    await screen.rerender(<Composer {...p} replyTo={null} />);
    expect(focus.mock.calls.length).toBe(before);
    await screen.rerender(<Composer {...p} replyTo={{ id: 'm1', role: 'assistant', excerpt: 'x' }} />);
    expect(focus.mock.calls.length).toBeGreaterThan(before);
    focus.mockRestore();
  });
});
