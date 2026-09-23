import { EventEmitter } from 'node:events';

/** A project's public switch moved. The public sockets watching it need to know at once. */
export interface PublicChange { project_id: string; is_public: boolean }

/**
 * Rooms left the street without their project being unpublished: a machine changed owner or was
 * deleted (every room on it, `project_id` absent), or one project was unlinked from a machine (that
 * one room). The public sockets watching one of them hang up, so the page re-reads the snapshot.
 */
export interface RoomsGone { machine_id: string; project_id?: string }

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
  publishRoomsGone(gone: RoomsGone): void { this.emitter.emit('rooms-gone', gone); }
  subscribeRoomsGone(listener: (gone: RoomsGone) => void): () => void {
    this.emitter.on('rooms-gone', listener);
    return () => this.emitter.off('rooms-gone', listener);
  }
  publishTabRemoved(removed: TabRemoved): void { this.emitter.emit('tab-removed', removed); }
  subscribeTabRemoved(listener: (removed: TabRemoved) => void): () => void {
    this.emitter.on('tab-removed', listener);
    return () => this.emitter.off('tab-removed', listener);
  }
}

export const publicBus = new PublicBus();
