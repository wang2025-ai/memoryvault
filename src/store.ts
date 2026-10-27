import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkText, extractTitle } from './chunk.js';
import { ensureVecTable, setMeta, vecTableExists, type Db } from './db.js';
import type { EmbeddingProvider } from './embeddings.js';

export interface AddResult {
  docId: number;
  source: string;
  title: string;
  chunks: number;
}

interface ChunkRow {
  id: number;
  content: string;
}

export function upsertDocument(
  db: Db,
  opts: { source: string; text: string; title?: string }
): AddResult {
  const pieces = chunkText(opts.text);
  if (pieces.length === 0) throw new Error(`empty content from ${opts.source}`);
  const title = opts.title?.trim() || extractTitle(opts.text, opts.source);
  const addedAt = new Date().toISOString();
  const docId = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM documents WHERE source = ?').get(opts.source) as
      | { id: number }
      | undefined;
    if (existing) removeDocument(db, existing.id);
    const id = Number(
      db
        .prepare('INSERT INTO documents (source, title, chunks, added_at) VALUES (?, ?, ?, ?)')
        .run(opts.source, title, pieces.length, addedAt).lastInsertRowid
    );
    const insertChunk = db.prepare('INSERT INTO chunks (doc_id, seq, content) VALUES (?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)');
    pieces.forEach((content, seq) => {
      const row = insertChunk.run(id, seq, content);
      insertFts.run(Number(row.lastInsertRowid), content);
    });
    return id;
  })();
  return { docId, source: opts.source, title, chunks: pieces.length };
}

export function removeDocument(db: Db, docId: number): void {
  db.transaction(() => {
    const chunkIds = (db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(docId) as Array<{ id: number }>).map(
      (r) => r.id
    );
    const deleteFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
    for (const id of chunkIds) deleteFts.run(id);
    if (vecTableExists(db)) {
      const deleteVec = db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
      for (const id of chunkIds) deleteVec.run(id);
    }
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  })();
}

/**
 * Generate embeddings for chunks that do not have a vector yet.
 * With docId set, only that document's chunks are (re-)embedded.
 */
export async function embedPending(
  db: Db,
  provider: EmbeddingProvider,
  docId?: number
): Promise<number> {
  const rows: ChunkRow[] =
    docId !== undefined
      ? (db.prepare('SELECT id, content FROM chunks WHERE doc_id = ?').all(docId) as ChunkRow[])
      : vecTableExists(db)
        ? (db.prepare(
            'SELECT id, content FROM chunks WHERE id NOT IN (SELECT rowid FROM vec_chunks)'
          ).all() as ChunkRow[])
        : (db.prepare('SELECT id, content FROM chunks').all() as ChunkRow[]);
  if (rows.length === 0) return 0;

  const batch = 32;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const vectors = await provider.embed(slice.map((r) => r.content));
    if (vectors.length === 0) break;
    ensureVecTable(db, vectors[0].length);
    // better-sqlite3 binds JS numbers as REAL, but vec0 requires an INTEGER rowid — hence BigInt
    const insert = db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)');
    db.transaction(() => {
      slice.forEach((row, j) => insert.run(BigInt(row.id), new Float32Array(vectors[j])));
    })();
    inserted += vectors.length;
  }
  if (docId === undefined && inserted > 0) setMeta(db, 'vec_provider', provider.name);
  return inserted;
}

export function listFiles(dir: string, exts: string[], recursive: boolean): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!recursive || entry.name === 'node_modules') continue;
        visit(full);
      } else if (exts.some((e) => entry.name.toLowerCase().endsWith(e))) {
        out.push(full);
      }
    }
  };
  visit(dir);
  return out;
}

export interface IndexSummary {
  indexed: number;
  skipped: number;
  failed: number;
  embedded: number;
}

export async function indexFolder(
  db: Db,
  provider: EmbeddingProvider | null,
  folder: string,
  opts: { exts?: string; recursive?: boolean } = {}
): Promise<IndexSummary> {
  const exts = (opts.exts ?? 'md,markdown,txt,json')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
  const files = listFiles(folder, exts, opts.recursive !== false);
  const summary: IndexSummary = { indexed: 0, skipped: 0, failed: 0, embedded: 0 };
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      summary.failed++;
      continue;
    }
    if (!raw.trim()) {
      summary.skipped++;
      continue;
    }
    let text = raw;
    if (file.toLowerCase().endsWith('.json')) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        text = raw;
      }
    }
    try {
      const result = upsertDocument(db, { source: file, text });
      if (provider) summary.embedded += await embedPending(db, provider, result.docId);
      summary.indexed++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
