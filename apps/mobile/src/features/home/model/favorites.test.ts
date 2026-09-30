import { favoriteProjects, isFavorite } from './favorites';

const project = (id: string, favorite_position?: number | null) => ({ id, favorite_position });

describe('favoriteProjects (TER-541)', () => {
  it('keeps the pinned projects only, in Favoritos order', () => {
    const list = [project('a', 1), project('b', null), project('c', 0)];
    expect(favoriteProjects(list).map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('counts a project persisted by an older build (no field) as not pinned', () => {
    expect(favoriteProjects([project('old'), project('new', 0)]).map((p) => p.id)).toEqual(['new']);
    expect(isFavorite(project('old'))).toBe(false);
  });

  it('does not reorder the list it is given', () => {
    const list = [project('a', 1), project('c', 0)];
    favoriteProjects(list);
    expect(list.map((p) => p.id)).toEqual(['a', 'c']);
  });
});
