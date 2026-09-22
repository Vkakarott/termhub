/** Remembers, per project, the last machine a terminal was opened on (localStorage; best effort). */
const LAST_MACHINE_KEY = (projectId: string) => `termhub:last-machine:${projectId}`;

export function readLastMachine(projectId: string): string | null {
  try {
    return localStorage.getItem(LAST_MACHINE_KEY(projectId));
  } catch {
    return null;
  }
}

export function writeLastMachine(projectId: string, machineId: string): void {
  try {
    localStorage.setItem(LAST_MACHINE_KEY(projectId), machineId);
  } catch {
    /* private mode */
  }
}
