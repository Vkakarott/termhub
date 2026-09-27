/**
 * The project chats kept mounted (spec 2026-09-26 project chat dock §4.2), most recent first: the one
 * on screen and the ones left behind last. A mounted panel keeps its socket, its streamed text, its
 * draft and its scroll, so going back shows an answer that kept streaming. Three bounds the cost.
 */
export const MAX_ALIVE_CHATS = 3;

export function touchAlive(alive: string[], id: string, max = MAX_ALIVE_CHATS): string[] {
  if (alive[0] === id) return alive;
  return [id, ...alive.filter((x) => x !== id)].slice(0, max);
}

export function dropAlive(alive: string[], id: string): string[] {
  return alive.includes(id) ? alive.filter((x) => x !== id) : alive;
}
