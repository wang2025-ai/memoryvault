import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db.js';
import type { VaultConfig } from '../src/config.js';
import { search } from '../src/search.js';
import { parseExts } from '../src/store.js';
import { syncFile, watchFolders } from '../src/watch.js';

const cfgNone: VaultConfig = { embedding: { provider: 'none' } };

let dir: string;
let db: Db;
const exts = parseExts();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvault-watch-'));
  db = openDb(join(dir, 'vault.db'));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('syncFile', () => {
  it('indexes a new file', async () => {
    const file = join(dir, 'watched.md');
    writeFileSync(file, '# Watched\n\nwatch this note please');
    const event = await syncFile(db, null, file, exts);
    expect(event.action).toBe('indexed');
    const hits = await search(db, cfgNone, 'watch this note');
    expect(hits.length).toBe(1);
  });

  it('re-indexes on change and replaces the old content', async () => {
    const file = join(dir, 'watched.md');
    writeFileSync(file, '# Watched\n\nupdated content about giraffes');
    const event = await syncFile(db, null, file, exts);
    expect(event.action).toBe('indexed');
    const stale = await search(db, cfgNone, 'watch this note');
    expect(stale).toHaveLength(0);
    const fresh = await search(db, cfgNone, 'giraffes');
    expect(fresh).toHaveLength(1);
    // the whole file merges into one chunk starting at its first line
    expect(fresh[0].line).toBe(1);
  });

  it('removes the document when the file is deleted', async () => {
    const file = join(dir, 'watched.md');
    unlinkSync(file);
    const event = await syncFile(db, null, file, exts);
    expect(event.action).toBe('removed');
    expect(await search(db, cfgNone, 'giraffes')).toHaveLength(0);
  });

  it('skips files with unsupported extensions', async () => {
    const file = join(dir, 'image.png');
    writeFileSync(file, 'not text');
    const event = await syncFile(db, null, file, exts);
    expect(event.action).toBe('skipped');
  });
});

describe('watchFolders', () => {
  it('picks up created files and indexes them (integration)', async () => {
    const folder = join(dir, 'live');
    mkdirSync(folder, { recursive: true });
    const events: string[] = [];
    const handle = watchFolders(db, null, [folder], { onEvent: (e) => events.push(e.action) });
    try {
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(join(folder, 'live.md'), 'live content about otters');
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      handle.stop();
    }
    expect(events).toContain('indexed');
    const hits = await search(db, cfgNone, 'otters');
    expect(hits.length).toBe(1);
  });
});
