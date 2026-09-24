import { EventEmitter } from 'node:events';

/** A project's public switch moved. The public sockets watching it need to know at once. */
export interface PublicChange { project_id: string; is_public: boolean }

/**
 * Robots left the street without their building being unpublished: a machine changed owner or was
 * deleted (every robot on it, `project_id` absent), or one project was unlinked from a machine (that
 * project's robots on it). The building stays; the public sockets that showed one of those robots
 * hang up, so the page re-reads the snapshot without them.
 */
export interface RobotsGone { machine_id: string; project_id?: string }

/**
 * A user was deleted: their nickname, and with it their whole city, is gone. Their projects and
 * machines survive with no owner, so no per-project or per-machine event says so on its own.
 */
export interface OwnerGone { owner_id: string }

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
  publishRobotsGone(gone: RobotsGone): void { this.emitter.emit('robots-gone', gone); }
  subscribeRobotsGone(listener: (gone: RobotsGone) => void): () => void {
    this.emitter.on('robots-gone', listener);
    return () => this.emitter.off('robots-gone', listener);
  }
  publishOwnerGone(gone: OwnerGone): void { this.emitter.emit('owner-gone', gone); }
  subscribeOwnerGone(listener: (gone: OwnerGone) => void): () => void {
    this.emitter.on('owner-gone', listener);
    return () => this.emitter.off('owner-gone', listener);
  }
  publishTabRemoved(removed: TabRemoved): void { this.emitter.emit('tab-removed', removed); }
  subscribeTabRemoved(listener: (removed: TabRemoved) => void): () => void {
    this.emitter.on('tab-removed', listener);
    return () => this.emitter.off('tab-removed', listener);
  }
}

export const publicBus = new PublicBus();
