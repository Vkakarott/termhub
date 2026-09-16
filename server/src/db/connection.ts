import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export type DB = Database.Database;

let db: DB | null = null;

export function openDb(dbPath = config.dbPath): DB {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error('Banco não inicializado. Chame openDb() primeiro.');
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
