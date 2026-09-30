// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { Project, ProjectAiView } from '../lib/types';

const get = vi.fn();
const save = vi.fn();
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { setup: { ai: { get: (...a: unknown[]) => get(...a), save: (...a: unknown[]) => save(...a) } } } }));

import { ProjectAiCard } from './ProjectAiCard';

const project = { id: 'p1', name: 'termhub' } as Project;
const view = (over: Partial<ProjectAiView['ai']> = {}): ProjectAiView => ({
  ai: { accounts: [], models: { claude: null, chatgpt: null }, ...over },
  available: [
    { id: 'a1', label: 'pessoal', provider: 'claude', machine_id: 'm1', machine_name: 'jarvis', default: true },
    { id: 'a2', label: 'trabalho', provider: 'claude', machine_id: 'm1', machine_name: 'jarvis', default: false },
    { id: 'c1', label: 'codex', provider: 'chatgpt', machine_id: 'm1', machine_name: 'jarvis', default: true },
  ],
});

beforeEach(() => {
  get.mockReset();
  save.mockReset();
});
afterEach(cleanup);

describe('ProjectAiCard', () => {
  it('says that without accounts every start asks for one, as today', async () => {
    get.mockResolvedValue(view());
    render(<ProjectAiCard project={project} />);
    expect(await screen.findByText('Sem contas escolhidas, cada início de agente pede a conta, como hoje.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar contas e modelo' })).toBeDisabled();
  });

  it('includes accounts in the order they are ticked, reorders them and saves the list with the model', async () => {
    get.mockResolvedValue(view());
    save.mockImplementation(async (_p: string, ai: ProjectAiView['ai']) => ({ ...view(), ai }));
    render(<ProjectAiCard project={project} />);
    fireEvent.click(await screen.findByLabelText('trabalho · Claude · jarvis'));
    fireEvent.click(screen.getByLabelText('pessoal (login padrão) · Claude · jarvis'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Subir' })[1]);
    fireEvent.change(screen.getByLabelText('Modelo padrão — Claude Code'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar contas e modelo' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('p1', { accounts: ['a1', 'a2'], models: { claude: 'opus', chatgpt: null } }));
    expect(await screen.findByText('Contas e modelo salvos.')).toBeInTheDocument();
  });

  it('warns about a full model id and refuses one the server would refuse', async () => {
    get.mockResolvedValue(view({ models: { claude: 'claude-opus-5-5', chatgpt: null } }));
    render(<ProjectAiCard project={project} />);
    const input = await screen.findByLabelText('Id do modelo — Claude Code');
    expect(screen.getByText(/Um CLI mais antigo numa máquina pode não reconhecer este id/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'opus; id' } });
    expect(screen.getByText('Use só letras, números, ponto, hífen, dois-pontos ou colchetes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar contas e modelo' })).toBeDisabled();
  });

  it("shows the server's refusal", async () => {
    get.mockResolvedValue(view());
    save.mockRejectedValue(new ApiError(400, 'A conta "x" está na máquina y, que não está ligada ao projeto'));
    render(<ProjectAiCard project={project} />);
    fireEvent.click(await screen.findByLabelText('trabalho · Claude · jarvis'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar contas e modelo' }));
    expect(await screen.findByText('A conta "x" está na máquina y, que não está ligada ao projeto')).toBeInTheDocument();
  });

  it('keeps accounts no longer available out of the list it shows and saves', async () => {
    get.mockResolvedValue(view({ accounts: ['gone', 'a2'] }));
    save.mockImplementation(async (_p: string, ai: ProjectAiView['ai']) => ({ ...view(), ai }));
    render(<ProjectAiCard project={project} />);
    fireEvent.change(await screen.findByLabelText('Modelo padrão — Codex'), { target: { value: '__other__' } });
    fireEvent.change(screen.getByLabelText('Id do modelo — Codex'), { target: { value: 'gpt-5-codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar contas e modelo' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('p1', { accounts: ['a2'], models: { claude: null, chatgpt: 'gpt-5-codex' } }));
  });
});
