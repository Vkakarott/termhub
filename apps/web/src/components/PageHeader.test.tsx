// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { PageFrame, PageHeader } from './PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders the title as the page heading, with a truncated subtitle and no tab strip', () => {
    render(
      <MemoryRouter>
        <PageHeader title="Máquinas" subtitle="3 máquinas" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Máquinas' })).toBeInTheDocument();
    expect(screen.getByText('3 máquinas')).toHaveClass('truncate', 'text-xs', 'text-fg-muted');
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('renders tabs as links after the title, marking the current one', () => {
    render(
      <MemoryRouter initialEntries={['/ai']}>
        <PageHeader
          title="Início"
          tabs={[
            { to: '/', label: 'Projetos', end: true },
            { to: '/ai', label: 'Contas de IA', end: true },
          ]}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Seções de Início' });
    expect(within(nav).getByRole('link', { name: 'Projetos' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Projetos' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Contas de IA' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows a tab badge after its label', () => {
    render(
      <MemoryRouter>
        <PageHeader title="alpha" tabs={[{ to: '/projects/p1/tasks', label: 'Tarefas', badge: 3 }]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Tarefas/ }).textContent).toBe('Tarefas3');
  });

  it('puts the extra content after the title and the actions at the right end', () => {
    render(
      <MemoryRouter>
        <PageHeader title="Escritório" extra={<nav aria-label="Trilha">Cidade</nav>} actions={<button>modo foco</button>} />
      </MemoryRouter>,
    );
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(within(header).getByLabelText('Trilha')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'modo foco' }).parentElement).toHaveClass('ml-auto');
  });
});

describe('PageHeader on a narrow window', () => {
  it('scrolls the tabs and the extra sideways instead of pushing the actions out, without clipping the header', () => {
    render(
      <MemoryRouter>
        <PageHeader
          title="alpha"
          tabs={[
            { to: '/a', label: 'Terminais' },
            { to: '/b', label: 'Tarefas' },
          ]}
          extra={<nav aria-label="Trilha">Cidade</nav>}
          actions={<button>publicar</button>}
        />
      </MemoryRouter>,
    );
    const middle = screen.getByRole('navigation', { name: 'Seções de alpha' }).parentElement!;
    expect(middle).toHaveClass('min-w-0', 'flex-1', 'overflow-x-auto');
    expect(middle).toContainElement(screen.getByLabelText('Trilha'));
    expect(screen.getByRole('button', { name: 'publicar' }).parentElement).toHaveClass('ml-auto', 'shrink-0');
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(header.className).not.toMatch(/overflow/);
  });

  it('can give the subtitle a longer tooltip than its text', () => {
    render(
      <MemoryRouter>
        <PageHeader title="alpha" subtitle="MEU · jarvis" subtitleTitle={'jarvis: /home/pedro/meu-projeto'} />
      </MemoryRouter>,
    );
    expect(screen.getByText('MEU · jarvis')).toHaveAttribute('title', 'jarvis: /home/pedro/meu-projeto');
  });
});

describe('PageFrame', () => {
  it('puts the header above a scrolling body', () => {
    render(
      <MemoryRouter>
        <PageFrame title="Máquinas" actions={<button>+ máquina</button>}>
          <p>corpo</p>
        </PageFrame>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: '+ máquina' }).closest('header')).not.toBeNull();
    expect(screen.getByText('corpo').parentElement).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'p-6');
  });
});
