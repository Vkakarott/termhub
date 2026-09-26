import type { ExternalRef } from './types';

/** The ticket key a card shows: new links carry `key`; legacy GitHub links carry "#12" and a scope. */
export function ticketKey(ref: ExternalRef): string {
  if (ref.key) return ref.key;
  if (ref.provider === 'github' && ref.identifier.startsWith('#') && ref.scope) return `${ref.scope}${ref.identifier}`;
  return ref.identifier;
}
