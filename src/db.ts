import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';

export type Db = Database.Database;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      chunks INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      content TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function vecTableExists(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'").get();
}

/**
 * Create (or recreate) the vector table for the given dimension.
 * Recreating invalidates existing vectors, so callers must re-embed afterwards.
 */
export function ensureVecTable(db: Db, dim: number): void {
  if (vecTableExists(db) && getMeta(db, 'vec_dim') === String(dim)) return;
  db.exec('DROP TABLE IF EXISTS vec_chunks');
  db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dim}])`);
  setMeta(db, 'vec_dim', String(dim));
  setMeta(db, 'vec_provider', '');
}
