import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus } from './bus.js';

/** The part of a machine the scope filter needs: whose it is. */
type MachineOwner = { id: string; owner_id: string | null };

/**
 * Tells the monitor subscribers a tab was opened or renamed, so the sidebar's open-tab list stays
 * live. Scoped like publishTabChange: by the owner of the machine the tab runs on.
 */
export function publishTabOpened(tab: Tab, machine: MachineOwner | undefined): void {
  monitorBus.publishLifecycle({ kind: 'upsert', tab, project_id: tab.project_id, machine_id: tab.machine_id, owner_id: machine?.owner_id ?? null });
}

/** Tells the monitor subscribers a tab is gone. */
export function publishTabRemoved(tab: Pick<Tab, 'id' | 'project_id' | 'machine_id'>, machine: MachineOwner | undefined): void {
  monitorBus.publishLifecycle({ kind: 'removed', tab_id: tab.id, project_id: tab.project_id, machine_id: tab.machine_id, owner_id: machine?.owner_id ?? null });
}

/**
 * Several tabs gone at once — a project or machine deleted (the database cascades them) or a
 * machine unlinked. Read the tabs before the delete; `known` saves the lookup for machines the
 * caller already holds, and each other machine's owner is read once.
 */
export async function publishTabsRemoved(repos: Repositories, tabs: Array<Pick<Tab, 'id' | 'project_id' | 'machine_id'>>, known: MachineOwner[] = []): Promise<void> {
  const owners = new Map<string, MachineOwner | undefined>(known.map((m) => [m.id, m]));
  for (const tab of tabs) {
    if (!owners.has(tab.machine_id)) owners.set(tab.machine_id, await repos.machines.findById(tab.machine_id));
    publishTabRemoved(tab, owners.get(tab.machine_id));
  }
}
