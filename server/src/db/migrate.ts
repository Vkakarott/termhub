import type { DB } from './connection.js';
import { migrations } from './migrations/index.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

export function runMigrations(db: DB, log: (msg: string) => void = () => {}): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const m of sorted) {
    if (seen.has(m.version)) throw new Error(`Migration duplicada: ${m.version}`);
    seen.add(m.version);
  }

  let count = 0;
  for (const m of sorted) {
    if (applied.has(m.version)) continue;
    const apply = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    apply();
    log(`migration ${m.version} aplicada: ${m.name}`);
    count++;
  }
  return count;
}
