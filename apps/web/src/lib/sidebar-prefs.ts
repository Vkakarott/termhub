/**
 * Sidebar view preferences, per browser: which projects have their agent list collapsed and which
 * sections (groups, Outros) are collapsed. Storage can be missing or throw (private mode, blocked
 * site data), so every access is guarded and the default (everything expanded) applies when it does.
 */
const COLLAPSED_KEY = 'termhub:sidebar:collapsed-projects';

export function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedProjects(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* not persisted: the in-memory state still works */
  }
}

/** Sidebar sections (group ids, and 'others' for Outros) the user collapsed. */
const GROUPS_KEY = 'termhub:sidebar:collapsed-groups';

export function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedGroups(ids: Set<string>): void {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([...ids]));
  } catch {
    /* not persisted: the in-memory state still works */
  }
}
