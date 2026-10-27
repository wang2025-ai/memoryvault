import { ensureVecTable, setMeta, vecTableExists, type Db } from './db.js';
import { extractFromFile, normalizeJsonText } from './extract.js';
import { chunkText, extractTitle } from './chunk.js';
import type { EmbeddingProvider } from './embeddings.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_EXTS = 'md,markdown,txt,json,pdf,html,htm';

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
    const insertChunk = db.prepare(
      'INSERT INTO chunks (doc_id, seq, content, start_line) VALUES (?, ?, ?, ?)'
    );
    const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)');
    pieces.forEach((piece, seq) => {
      const row = insertChunk.run(id, seq, piece.content, piece.startLine);
      insertFts.run(Number(row.lastInsertRowid), piece.content);
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

export interface DocRef {
  id: number;
  source: string;
  title: string;
}

/** Resolve a CLI reference to a document: numeric id, exact source, or source suffix. */
export function findDocRef(db: Db, ref: string): DocRef | undefined {
  if (/^\d+$/.test(ref)) {
    const byId = db.prepare('SELECT id, source, title FROM documents WHERE id = ?').get(Number(ref)) as
      | DocRef
      | undefined;
    if (byId) return byId;
  }
  const exact = db.prepare('SELECT id, source, title FROM documents WHERE source = ?').get(ref) as
    | DocRef
    | undefined;
  if (exact) return exact;
  const escaped = ref.replace(/([\\%_])/g, '\\$1');
  return db
    .prepare(
      "SELECT id, source, title FROM documents WHERE source LIKE '%' || ? ESCAPE '\\' ORDER BY id LIMIT 1"
    )
    .get(escaped) as DocRef | undefined;
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

export function parseExts(exts?: string): string[] {
  return (exts ?? DEFAULT_EXTS)
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
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
  const exts = parseExts(opts.exts);
  const files = listFiles(folder, exts, opts.recursive !== false);
  const summary: IndexSummary = { indexed: 0, skipped: 0, failed: 0, embedded: 0 };
  for (const file of files) {
    try {
      const extracted = await extractFromFile(file);
      const text = file.toLowerCase().endsWith('.json') ? normalizeJsonText(extracted.text) : extracted.text;
      if (!text.trim()) {
        summary.skipped++;
        continue;
      }
      const result = upsertDocument(db, { source: file, text });
      if (provider) summary.embedded += await embedPending(db, provider, result.docId);
      summary.indexed++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
