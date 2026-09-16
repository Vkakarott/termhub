import type { Migration } from '../migrate.js';
import { migration as m001 } from './001_initial.js';

/** Lista ordenada de migrations. Adicione novas no final com version incremental. */
export const migrations: Migration[] = [m001];
