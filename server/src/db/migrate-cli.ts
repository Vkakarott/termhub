import { openDb, closeDb } from './connection.js';
import { runMigrations } from './migrate.js';
import { config } from '../config.js';

const db = openDb();
const n = runMigrations(db, (m) => console.log(m));
console.log(n === 0 ? 'Banco já está atualizado.' : `${n} migration(s) aplicada(s).`, `(${config.dbPath})`);
closeDb();
