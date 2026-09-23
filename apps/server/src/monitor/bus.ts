import { EventEmitter } from 'node:events';
import type { Tab } from '../db/repositories/types.js';

/** A tab's monitor state changed. `owner_id` lets subscribers filter by scope without a lookup. */
export interface TabStateChange {
  tab: Tab;
  project_id: string;
  machine_id: string;
  owner_id: string | null;
}

type Listener = (change: TabStateChange) => void;

/**
 * A tab was opened or renamed (`upsert`, carrying the whole row) or closed (`removed`). Its own
 * channel: the state subscribers (wait_for_state, the public city) only ever see state changes.
 */
export type TabLifecycle =
  | { kind: 'upsert'; tab: Tab; project_id: string; machine_id: string; owner_id: string | null }
  | { kind: 'removed'; tab_id: string; project_id: string; machine_id: string; owner_id: string | null };

/** In-process fan-out of monitor state changes (one server process; the WS handler subscribes). */
class MonitorBus {
  private emitter = new EventEmitter();

  constructor() {
    // one listener per WS client plus one per in-flight wait_for_state: no fixed ceiling
    this.emitter.setMaxListeners(0);
  }

  publish(change: TabStateChange): void {
    this.emitter.emit('tab', change);
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on('tab', listener);
    return () => this.emitter.off('tab', listener);
  }

  publishLifecycle(event: TabLifecycle): void {
    this.emitter.emit('lifecycle', event);
  }

  subscribeLifecycle(listener: (event: TabLifecycle) => void): () => void {
    this.emitter.on('lifecycle', listener);
    return () => this.emitter.off('lifecycle', listener);
  }

  /** Number of state subscribers (tests, diagnostics). */
  listenerCount(): number {
    return this.emitter.listenerCount('tab');
  }
}

export const monitorBus = new MonitorBus();
