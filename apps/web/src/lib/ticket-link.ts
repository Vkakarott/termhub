import type { ExternalRef } from './types';

/** The ticket key a card shows: new links carry `key`; legacy GitHub links carry "#12" and a scope. */
export function ticketKey(ref: ExternalRef): string {
  if (ref.key) return ref.key;
  if (ref.provider === 'github' && ref.identifier.startsWith('#') && ref.scope) return `${ref.scope}${ref.identifier}`;
  return ref.identifier;
}

/**
 * The title a linked card shows. Cards imported before 2026-09-26 carry the key in the title
 * ("EI-123 Título", "#12 Título"), and the key is now a subtitle: drop that prefix on display only.
 */
export function cardTitle(title: string, ref: ExternalRef | null): string {
  const prefix = ref?.identifier ? `${ref.identifier} ` : '';
  return prefix && title.startsWith(prefix) && title.length > prefix.length ? title.slice(prefix.length) : title;
}
