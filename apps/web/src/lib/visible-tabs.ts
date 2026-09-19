/**
 * Which tabs are on screen right now, per project (each project's terminals view reports its
 * own). Read by the "needs you" toasts, which stay quiet for a tab the person is looking at.
 */
const onScreen = new Map<string, readonly string[]>();

export function setTabsOnScreen(projectId: string, tabIds: readonly string[]): void {
  if (tabIds.length) onScreen.set(projectId, tabIds);
  else onScreen.delete(projectId);
}

export function isTabOnScreen(tabId: string): boolean {
  for (const ids of onScreen.values()) if (ids.includes(tabId)) return true;
  return false;
}
