// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatHost } from './ChatHost';
import type { ChatHostMachine, ChatHostState } from '../../lib/types';

const machine = (id: string, name: string): ChatHostMachine => ({ id, name });

/** Every prop the page owns, defaulted, so each test names only the one it is about. */
function show(host: ChatHostState, over: Partial<Parameters<typeof ChatHost>[0]> = {}) {
  const props = {
    host,
    machines: null,
    picking: false,
    changing: false,
    error: null,
    onPick: vi.fn(),
    onCancelPick: vi.fn(),
    onChoose: vi.fn(),
    ...over,
  };
  render(
    <MemoryRouter>
      <ChatHost {...props} />
    </MemoryRouter>,
  );
  return props;
}

afterEach(() => cleanup());

it('names the machine and the account running the conversation', async () => {
  show({ kind: 'ready', machine: machine('m1', 'jarvis'), configDir: '/home/u/.claude-work', account: { kind: 'chosen', id: 'acc1', label: 'trabalho' } });

  // Nobody should have to guess whose computer is thinking, or on whose Claude account.
  expect(screen.getByText(/máquina jarvis/i)).toBeTruthy();
  expect(screen.getByText(/conta trabalho/i)).toBeTruthy();
});

it('says the login is the machine default when no account was chosen', async () => {
  show({ kind: 'ready', machine: machine('m1', 'jarvis'), configDir: null, account: { kind: 'default' } });

  expect(screen.getByText(/conta padrão do Claude/i)).toBeTruthy();
  expect(screen.queryByText(/não serve/i)).toBeNull(); // nothing was lost: nothing to report
});

it('says so when the chosen account no longer serves this machine, instead of degrading in silence', async () => {
  show({ kind: 'ready', machine: machine('m1', 'jarvis'), configDir: null, account: { kind: 'lost' } });

  expect(screen.getByText(/conta de IA que você escolheu não serve/i)).toBeTruthy();
  expect(screen.getByText(/conta padrão do Claude/i)).toBeTruthy(); // …and what is running instead
});

it('with no machine, states the product shape and offers the way to enrol one', async () => {
  show({ kind: 'no_machine' });

  // Not an error: the conversation runs on a machine of their own, and there is none yet.
  expect(screen.getByText(/roda em uma máquina sua/i)).toBeTruthy();
  expect(screen.getByText(/cadastre uma máquina com o agente do termhub/i)).toBeTruthy();
  const link = screen.getByRole('link', { name: /cadastrar máquina/i });
  expect(link.getAttribute('href')).toBe('/');
});

it('lists the machines to choose between, and picking one sets the host', async () => {
  const props = show({ kind: 'not_chosen', machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')], sessionAtStake: false });

  expect(screen.getByText(/escolha em qual/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'jarvis' }));

  expect(props.onChoose).toHaveBeenCalledWith('m2');
});

it('picking the first machine warns about nothing: there is no session to lose', async () => {
  show({ kind: 'not_chosen', machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')], sessionAtStake: false });

  // A warning that is usually false is a warning nobody reads — so this one is not shown here.
  expect(screen.queryByText(/memória do modelo/i)).toBeNull();
  expect(screen.getByRole('button', { name: 'jarvis' })).toBeTruthy();
});

it('warns before the pick when a session is at stake, because the machine that held it is no longer chosen', async () => {
  const props = show({ kind: 'not_chosen', machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')], sessionAtStake: true });

  // On screen before any machine is picked: this is the case where the model's memory really does go.
  expect(screen.getByText(/já tem uma sessão/i)).toBeTruthy();
  expect(screen.getByText(/memória do modelo começa de novo/i)).toBeTruthy();
  expect(props.onChoose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'jarvis' }));
  expect(props.onChoose).toHaveBeenCalledWith('m2');
});

it('names the offline machine and offers to change the host, without reading as a bug in the chat', async () => {
  const props = show({ kind: 'offline', machine: machine('m2', 'jarvis') });

  expect(screen.getByText(/máquina jarvis está offline/i)).toBeTruthy();
  expect(screen.getByText(/ligue-a/i)).toBeTruthy();
  // Nothing here blames the person, and nothing calls it a failure of the chat.
  expect(screen.queryByText(/erro|falha|não foi possível/i)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /trocar máquina/i }));
  expect(props.onPick).toHaveBeenCalled();
});

it('reads as an instruction when the agent is too old, naming the version', async () => {
  show({ kind: 'agent_too_old', machine: machine('m1', 'macbook'), version: '0.4.9' });

  expect(screen.getByText(/versão 0\.4\.9/)).toBeTruthy();
  expect(screen.getByText(/atualize o agente/i)).toBeTruthy();
  // …and where the update button is, since it does not live on this screen.
  expect(screen.getByRole('link', { name: /atualizar o agente/i }).getAttribute('href')).toBe('/');
});

it('drops the version when the agent never said which one it is', async () => {
  show({ kind: 'agent_too_old', machine: machine('m1', 'macbook'), version: '' });

  expect(screen.getByText(/ainda não sabe rodar o chat/i)).toBeTruthy();
  expect(screen.queryByText(/versão/i)).toBeNull(); // never an invented "(versão )"
});

it('warns that the session starts over before changing anything, and does nothing until it is confirmed', async () => {
  const props = show({ kind: 'ready', machine: machine('m1', 'macbook'), configDir: null, account: { kind: 'default' } }, { picking: true, machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')] });

  // The warning is on screen while nothing has been changed yet.
  expect(screen.getByText(/histórico desta conversa fica, mas a memória do modelo começa de novo/i)).toBeTruthy();
  expect(props.onChoose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /trocar para jarvis/i }));
  expect(props.onChoose).toHaveBeenCalledWith('m2');
});

it('does not offer the current host as something to change to', async () => {
  show({ kind: 'ready', machine: machine('m1', 'macbook'), configDir: null, account: { kind: 'default' } }, { picking: true, machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')] });

  expect(screen.getByText(/macbook \(atual\)/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /trocar para macbook/i })).toBeNull();
});

it('says the machines are still being read while the picker has none yet', async () => {
  show({ kind: 'offline', machine: machine('m2', 'jarvis') }, { picking: true, machines: null });

  expect(screen.getByText(/carregando suas máquinas/i)).toBeTruthy();
});

it('shows what a failed host change failed with, in the server words', async () => {
  show({ kind: 'not_chosen', machines: [machine('m1', 'macbook')], sessionAtStake: false }, { error: 'O chat só roda em uma máquina com o agente do termhub instalado' });

  expect(screen.getByText(/só roda em uma máquina com o agente/i)).toBeTruthy();
});

it('cannot be clicked twice while the change is in flight', async () => {
  show({ kind: 'not_chosen', machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')], sessionAtStake: false }, { changing: true });

  for (const name of ['macbook', 'jarvis']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
});
