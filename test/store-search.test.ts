import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, vecTableExists, type Db } from '../src/db.js';
import type { EmbeddingProvider } from '../src/embeddings.js';
import type { VaultConfig } from '../src/config.js';
import { embedPending, findDocRef, indexFolder, removeDocument, upsertDocument } from '../src/store.js';
import { rrfFuse, search, type SearchHit } from '../src/search.js';

const cfgNone: VaultConfig = { embedding: { provider: 'none' } };

const KEYWORDS: Record<string, number> = { database: 0, vector: 1, cooking: 2, pasta: 3 };

/** Deterministic fake embeddings: a bag-of-keywords vector with dim 8. */
class FakeProvider implements EmbeddingProvider {
  readonly name = 'fake';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const vec = new Array(8).fill(0);
      const lower = t.toLowerCase();
      for (const [kw, idx] of Object.entries(KEYWORDS)) {
        if (lower.includes(kw)) vec[idx] = 1;
      }
      return vec;
    });
  }
}

let dir: string;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvault-test-'));
  db = openDb(join(dir, 'vault.db'));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addDoc(source: string, text: string): number {
  return upsertDocument(db, { source, text }).docId;
}

describe('lexical search (provider: none)', () => {
  it('finds English documents via FTS trigram', async () => {
    addDoc('/notes/db.md', '# Databases\n\nVector search is a database technique. Databases store rows.');
    const hits = await search(db, cfgNone, 'database');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe('Databases');
    expect(hits[0].line).toBe(1);
    expect(hits[0].matchedBy).toContain('lexical');
  });

  it('anchors chunks to their source line', async () => {
    addDoc('/notes/anchor.md', `# Anchor\n\n${'a'.repeat(1000)}\n\nzebra lives in this paragraph`);
    const hits = await search(db, cfgNone, 'zebra lives');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].line).toBe(5); // line 1 heading, line 3 big paragraph (force-split), line 5 the zebra paragraph
  });

  it('finds Chinese documents via FTS trigram', async () => {
    addDoc('/notes/ml.md', '# 机器学习笔记\n\n今天复习了机器学习中的梯度下降算法，效果不错。');
    const hits = await search(db, cfgNone, '机器学习');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe('/notes/ml.md');
  });

  it('degrades to LIKE scan for short queries', async () => {
    const hits = await search(db, cfgNone, '学习');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('机器学习');
  });

  it('matches ASCII case-insensitively', async () => {
    addDoc('/notes/mcp.md', 'MCP is a protocol for connecting AI tools.');
    const hits = await search(db, cfgNone, 'mcp is a protocol');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns no results for unmatched queries', async () => {
    const hits = await search(db, cfgNone, 'zzzqqqxxx');
    expect(hits).toHaveLength(0);
  });
});

describe('upsert semantics', () => {
  it('replaces a document with the same source', async () => {
    addDoc('/notes/replace.md', 'original alpha content');
    addDoc('/notes/replace.md', 'replacement beta content');
    const docs = (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n;
    expect(docs).toBe(5); // db.md, ml.md, mcp.md, anchor.md, replace.md
    const old = await search(db, cfgNone, 'alpha');
    expect(old).toHaveLength(0);
    const fresh = await search(db, cfgNone, 'beta');
    expect(fresh).toHaveLength(1);
  });

  it('removes documents by id, exact source or suffix', async () => {
    addDoc('/notes/tmp/rm-me.md', 'removable content about quokkas');
    const bySuffix = findDocRef(db, 'rm-me.md');
    expect(bySuffix).toBeDefined();
    const byId = findDocRef(db, String(bySuffix!.id));
    expect(byId!.source).toBe(bySuffix!.source);
    expect(findDocRef(db, 'does-not-exist.md')).toBeUndefined();

    removeDocument(db, byId!.id);
    expect(await search(db, cfgNone, 'quokkas')).toHaveLength(0);
    // the FTS index must be clean too
    const ftsRows = (db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }).n;
    const chunkRows = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
    expect(ftsRows).toBe(chunkRows);
  });
});

describe('folder indexing', () => {
  it('indexes supported files recursively and skips hidden/node_modules', async () => {
    const folder = join(dir, 'notes');
    mkdirSync(join(folder, 'sub'), { recursive: true });
    mkdirSync(join(folder, 'node_modules'), { recursive: true });
    writeFileSync(join(folder, 'a.md'), 'alpha file about databases');
    writeFileSync(join(folder, 'b.txt'), 'plain text file');
    writeFileSync(join(folder, 'sub', 'c.md'), '# Nested\n\nnested content about pasta');
    writeFileSync(join(folder, '.hidden.md'), 'should be skipped');
    writeFileSync(join(folder, 'node_modules', 'x.md'), 'should be skipped');
    writeFileSync(join(folder, 'skip.bin'), 'should be skipped');

    const summary = await indexFolder(db, null, folder);
    expect(summary.indexed).toBe(3);
    expect(summary.skipped).toBe(0);
    const hits = await search(db, cfgNone, 'pasta');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toContain(join('sub', 'c.md'));
  });
});

describe('vector search and hybrid fusion', () => {
  const fake = new FakeProvider();

  it('creates the vector table and fills vectors on demand', async () => {
    expect(vecTableExists(db)).toBe(false);
    const n = await embedPending(db, fake);
    expect(n).toBeGreaterThan(0);
    expect(vecTableExists(db)).toBe(true);
    const vectors = (db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get() as { n: number }).n;
    const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
    expect(vectors).toBe(chunks);
  });

  it('finds results in vector-only mode', async () => {
    const hits = await search(db, cfgNone, 'cooking pasta', 5, 'vector', fake);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matchedBy).toEqual(['vector']);
    expect(hits[0].content.toLowerCase()).toContain('pasta');
  });

  it('fuses lexical and vector layers with RRF', async () => {
    const hits = await search(db, cfgNone, 'database', 5, 'auto', fake);
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top.matchedBy).toContain('lexical');
    expect(top.matchedBy).toContain('vector');
  });

  it('degrades gracefully when the embedding provider fails', async () => {
    const broken: EmbeddingProvider = {
      name: 'broken',
      async embed() {
        throw new Error('provider down');
      },
    };
    const hits = await search(db, cfgNone, 'database', 5, 'auto', broken);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.matchedBy.includes('vector'))).toBe(true);
  });

  it('rrfFuse prefers rows matched by both layers', () => {
    const row = (id: number) => ({ id, doc_id: id, seq: 0, content: 'c', source: 's', title: 't' });
    const fused = rrfFuse([row(1), row(2)], [row(2), row(3)], 10);
    expect(fused[0].row.id).toBe(2);
    expect(fused[0].matchedBy).toEqual(['lexical', 'vector']);
  });
});
