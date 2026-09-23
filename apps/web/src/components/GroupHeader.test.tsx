// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Section } from '../lib/project-groups-model';
import { GroupHeader } from './GroupHeader';

const section: Section = { id: 'g1', kind: 'custom', label: 'Clientes', projects: [] };
afterEach(() => cleanup());

const mount = (onRename = vi.fn(), onEditEnd = vi.fn()) => {
  render(<GroupHeader section={section} collapsed={false} onToggle={vi.fn()} editable onRename={onRename} onDelete={vi.fn()} onEditEnd={onEditEnd} />);
  fireEvent.click(screen.getByTitle('Renomear grupo'));
  return { onRename, onEditEnd, input: screen.getByRole('textbox') };
};

describe('GroupHeader editing', () => {
  it('reports the end of editing on Esc, without renaming', () => {
    const { onRename, onEditEnd, input } = mount();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onEditEnd).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('reports the end of editing on a blur that changed nothing', () => {
    const { onRename, onEditEnd, input } = mount();
    fireEvent.blur(input);
    expect(onEditEnd).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('reports it once on a saved rename', () => {
    const { onRename, onEditEnd, input } = mount();
    fireEvent.change(input, { target: { value: 'Trabalho' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Trabalho');
    expect(onEditEnd).toHaveBeenCalledTimes(1);
  });
});
