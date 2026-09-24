/** What a rebuild depends on. Pure: no PixiJS, so it can be tested alone. */
import type { CityModel } from '../model';

/**
 * Which buildings and desks exist — ids, kinds, order — and nothing about their state: `b{d:kind}`
 * per building. The same shape means a repaint in place; a new one means the city is rebuilt.
 */
export function shapeOf(city: CityModel): string {
  return city.buildings.map((b) => `${b.id}{${b.desks.map((d) => `${d.id}:${d.kind}`).join(',')}}`).join(';');
}
