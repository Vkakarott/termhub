import type { ViewAs } from './types';

/** What an admin's "Ver como" scope reads as in the chrome and in Perfil; null when viewing their own data. */
export function viewAsLabel(viewAs: ViewAs | undefined): string | null {
  if (!viewAs) return null;
  return viewAs === 'all' ? 'Vendo: todas as máquinas' : `Vendo como ${viewAs.name}`;
}
