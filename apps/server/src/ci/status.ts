/** Last CI sync error per project, in this process (spec §5.3); the progress route shows it on the epic. */
const errors = new Map<string, string>();

export function setCiError(projectId: string, message: string | null): void {
  if (message) errors.set(projectId, message);
  else errors.delete(projectId);
}

export function ciErrorOf(projectId: string): string | null {
  return errors.get(projectId) ?? null;
}
