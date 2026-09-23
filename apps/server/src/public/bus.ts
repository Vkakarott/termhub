import { EventEmitter } from 'node:events';

/** A project's public switch moved. The public sockets watching it need to know at once. */
export interface PublicChange { project_id: string; is_public: boolean }

/** A tab was closed or deleted. The monitor bus carries state changes only, never a removal. */
export interface TabRemoved { tab_id: string; project_id: string; machine_id: string }

class PublicBus {
  private emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(0); }
  publish(change: PublicChange): void { this.emitter.emit('public', change); }
  subscribe(listener: (change: PublicChange) => void): () => void {
    this.emitter.on('public', listener);
    return () => this.emitter.off('public', listener);
  }
  publishTabRemoved(removed: TabRemoved): void { this.emitter.emit('tab-removed', removed); }
  subscribeTabRemoved(listener: (removed: TabRemoved) => void): () => void {
    this.emitter.on('tab-removed', listener);
    return () => this.emitter.off('tab-removed', listener);
  }
}

export const publicBus = new PublicBus();
