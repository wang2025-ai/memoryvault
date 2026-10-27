import type { VaultConfig } from './config.js';
import { vecTableExists, type Db } from './db.js';
import { getProvider, type EmbeddingProvider } from './embeddings.js';

export type SearchMode = 'auto' | 'lexical' | 'vector';

export interface SearchHit {
  docId: number;
  source: string;
  title: string;
  seq: number;
  /** 1-based line number of the chunk start in the source file */
  line: number;
  content: string;
  score: number;
  matchedBy: Array<'lexical' | 'vector'>;
}

interface Row {
  id: number;
  doc_id: number;
  seq: number;
  content: string;
  start_line: number;
  source: string;
  title: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function lexicalRows(db: Db, query: string, limit: number): Row[] {
  const q = query.trim();
  if (!q) return [];
  // trigram MATCH needs at least 3 characters; shorter queries take the LIKE path
  if ([...q].length >= 3) {
    const phrase = `"${q.replace(/"/g, '""')}"`;
    try {
      return db
        .prepare(
          `SELECT chunks.id, chunks.doc_id, chunks.seq, chunks.content, chunks.start_line, documents.source, documents.title
           FROM chunks_fts
           JOIN chunks ON chunks.id = chunks_fts.rowid
           JOIN documents ON documents.id = chunks.doc_id
           WHERE chunks_fts MATCH ?
           ORDER BY bm25(chunks_fts)
           LIMIT ?`
        )
        .all(phrase, limit) as Row[];
    } catch {
      // malformed MATCH input falls through to the LIKE scan
    }
  }
  const needle = q.replace(/([\\%_])/g, '\\$1');
  const rows = db
    .prepare(
      `SELECT chunks.id, chunks.doc_id, chunks.seq, chunks.content, chunks.start_line, documents.source, documents.title
       FROM chunks
       JOIN documents ON documents.id = chunks.doc_id
       WHERE chunks.content LIKE '%' || ? || '%' ESCAPE '\\'
       LIMIT ?`
    )
    .all(needle, limit * 5) as Row[];
  return rows
    .map((r) => ({ r, n: countOccurrences(r.content, q) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((x) => x.r);
}

function vectorRows(db: Db, queryVector: number[], limit: number): Row[] {
  // k must bind as INTEGER — better-sqlite3 binds JS numbers as REAL
  const knn = db
    .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance')
    .all(new Float32Array(queryVector), BigInt(limit)) as Array<{ rowid: number; distance: number }>;
  if (knn.length === 0) return [];
  const rank = new Map<number, number>();
  knn.forEach((r, i) => rank.set(Number(r.rowid), i));
  const ids = knn.map((r) => Number(r.rowid));
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT chunks.id, chunks.doc_id, chunks.seq, chunks.content, chunks.start_line, documents.source, documents.title
       FROM chunks
       JOIN documents ON documents.id = chunks.doc_id
       WHERE chunks.id IN (${placeholders})`
    )
    .all(...ids) as Row[];
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/** Reciprocal Rank Fusion over the lexical and vector result lists. */
export function rrfFuse(
  lex: Row[],
  vec: Row[],
  limit: number,
  k = 60
): Array<{ row: Row; score: number; matchedBy: Array<'lexical' | 'vector'> }> {
  const map = new Map<number, { row: Row; score: number; matchedBy: Set<'lexical' | 'vector'> }>();
  const bump = (row: Row, rank: number, tag: 'lexical' | 'vector'): void => {
    const entry = map.get(row.id) ?? { row, score: 0, matchedBy: new Set() };
    entry.score += 1 / (k + rank + 1);
    entry.matchedBy.add(tag);
    map.set(row.id, entry);
  };
  lex.forEach((row, i) => bump(row, i, 'lexical'));
  vec.forEach((row, i) => bump(row, i, 'vector'));
  return [...map.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({ row: e.row, score: e.score, matchedBy: [...e.matchedBy] }));
}

export async function search(
  db: Db,
  cfg: VaultConfig,
  query: string,
  limit = 8,
  mode: SearchMode = 'auto',
  providerOverride?: EmbeddingProvider | null
): Promise<SearchHit[]> {
  const provider = providerOverride !== undefined ? providerOverride : getProvider(cfg);
  const wantLexical = mode !== 'vector';
  const wantVector = mode !== 'lexical' && provider !== null && vecTableExists(db);

  const lex = wantLexical ? lexicalRows(db, query, limit) : [];
  let vec: Row[] = [];
  if (wantVector) {
    try {
      const [queryVector] = await provider!.embed([query]);
      if (queryVector && queryVector.length > 0) vec = vectorRows(db, queryVector, limit);
    } catch {
      // embedding failure degrades gracefully to lexical results
    }
  }

  return rrfFuse(lex, vec, limit).map(({ row, score, matchedBy }) => ({
    docId: row.doc_id,
    source: row.source,
    title: row.title,
    seq: row.seq,
    line: row.start_line,
    content: row.content,
    score,
    matchedBy,
  }));
}

export function makeSnippet(content: string, query: string, width = 220): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const needle = query.trim();
  const at = needle ? flat.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return flat.slice(0, width) + (flat.length > width ? '…' : '');
  const start = Math.max(0, at - Math.floor(width / 3));
  return (start > 0 ? '…' : '') + flat.slice(start, start + width) + (start + width < flat.length ? '…' : '');
}
