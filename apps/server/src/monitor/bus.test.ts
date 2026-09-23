import { describe, expect, it } from 'vitest';
import { monitorBus } from './bus.js';

describe('monitorBus', () => {
  it('takes more than 10 subscribers (WS clients + concurrent waits) without a MaxListeners warning', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    const offs = Array.from({ length: 25 }, () => monitorBus.subscribe(() => {}));
    try {
      await new Promise((r) => setTimeout(r, 10)); // process warnings are emitted on a later tick
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      offs.forEach((off) => off());
      process.off('warning', onWarning);
    }
  });
});

describe('monitorBus lifecycle', () => {
  it('delivers tab opened/removed events on their own channel, never to the state subscribers', () => {
    const state: unknown[] = [];
    const lifecycle: unknown[] = [];
    const offState = monitorBus.subscribe((c) => state.push(c));
    const offLife = monitorBus.subscribeLifecycle((e) => lifecycle.push(e));
    try {
      monitorBus.publishLifecycle({ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
      expect(lifecycle).toEqual([{ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' }]);
      expect(state).toEqual([]); // wait_for_state and the public city keep seeing only state changes
    } finally {
      offState();
      offLife();
    }
  });
});
