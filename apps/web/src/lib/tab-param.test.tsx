// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFocusTabFromParam } from './tab-param';

afterEach(() => cleanup());

type Tabs = Array<{ id: string }> | null;

/** A stand-in for TerminalsView: a tab list that `load` replaces with the server's. */
function harness(initial: Tabs, server: () => Tabs) {
  const focus = vi.fn();
  const ctl = {} as { search: string; navigate: (to: string) => void; setTabs: (t: Tabs) => void };
  const load = vi.fn(async () => ctl.setTabs(server()));
  function View() {
    const [tabs, setTabs] = useState<Tabs>(initial);
    ctl.setTabs = setTabs;
    ctl.search = useLocation().search;
    ctl.navigate = useNavigate();
    useFocusTabFromParam(tabs, load, focus);
    return null;
  }
  return { View, focus, load, ctl };
}

const mount = (url: string, View: () => null) => render(<MemoryRouter initialEntries={[url]}><View /></MemoryRouter>);

describe('useFocusTabFromParam', () => {
  it('focuses a tab it already has and clears ?tab', async () => {
    const h = harness([{ id: 't1' }], () => [{ id: 't1' }]);
    await act(async () => void mount('/projects/p1?tab=t1', h.View));
    expect(h.focus).toHaveBeenCalledWith('t1');
    expect(h.load).not.toHaveBeenCalled();
    expect(h.ctl.search).toBe('');
  });

  it('focuses a tab it did not know once the reload brings it (a tab just opened elsewhere)', async () => {
    const h = harness([{ id: 't1' }], () => [{ id: 't1' }, { id: 'new' }]);
    await act(async () => void mount('/projects/p1?tab=new', h.View));
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.focus).toHaveBeenCalledWith('new');
    expect(h.ctl.search).toBe('');
  });

  it('works when already on the page: a later ?tab for an unknown tab still gets focused', async () => {
    const h = harness([{ id: 't1' }], () => [{ id: 't1' }, { id: 'new' }]);
    await act(async () => void mount('/projects/p1', h.View));
    await act(async () => h.ctl.navigate('/projects/p1?tab=new'));
    expect(h.focus).toHaveBeenCalledWith('new');
  });

  it('gives up on a tab the reload does not bring (reloads once, focuses nothing)', async () => {
    const h = harness([{ id: 't1' }], () => [{ id: 't1' }]);
    await act(async () => void mount('/projects/p1?tab=gone', h.View));
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.focus).not.toHaveBeenCalled();
    await act(async () => h.ctl.setTabs([{ id: 't1' }, { id: 'gone' }])); // a later list change does not resurrect it
    expect(h.focus).not.toHaveBeenCalled();
  });

  it('waits for the first load before deciding', async () => {
    const h = harness(null, () => [{ id: 't1' }]);
    await act(async () => void mount('/projects/p1?tab=t1', h.View));
    expect(h.focus).not.toHaveBeenCalled();
    await act(async () => h.ctl.setTabs([{ id: 't1' }]));
    expect(h.focus).toHaveBeenCalledWith('t1');
  });
});
