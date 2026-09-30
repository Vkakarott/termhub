// The person's Favoritos as the phone shows them (TER-541): the same group as the web sidebar's pin.
// A project persisted by a build older than the field has no `favorite_position` at all: not pinned.
type Pinnable = { favorite_position?: number | null };

export function isFavorite(project: Pinnable): boolean {
  return typeof project.favorite_position === 'number';
}

/** The pinned projects, in Favoritos order. */
export function favoriteProjects<T extends Pinnable>(projects: T[]): T[] {
  return projects.filter(isFavorite).sort((a, b) => a.favorite_position! - b.favorite_position!);
}
