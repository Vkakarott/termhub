/**
 * Which "local" machines (Machine.is_local — the user's own computer, running the agent) belong to
 * this browser. The server cannot tell which computer a browser is on, so the browser that adds a
 * local machine remembers its id here; other browsers hide it (and its projects) until the user
 * claims it from the sidebar. Per browser only: cleared data or another browser starts empty.
 */
const KEY = 'termhub:local-machines';

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable: the machine stays hidden after reload */
  }
}

export function localMachineIds(): Set<string> {
  return new Set(read());
}

export function rememberLocalMachine(id: string): void {
  const ids = read();
  if (!ids.includes(id)) write([...ids, id]);
}

export function forgetLocalMachine(id: string): void {
  write(read().filter((x) => x !== id));
}
