import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from './db.js';
import type { EmbeddingProvider } from './embeddings.js';
import { extractFromFile, normalizeJsonText } from './extract.js';
import { embedPending, parseExts, removeDocument, upsertDocument } from './store.js';

export interface SyncEvent {
  path: string;
  action: 'indexed' | 'removed' | 'skipped';
  detail?: string;
}

/**
 * Bring a single file in sync with the vault: index it if it exists,
 * remove its document if it was deleted. Used by `mvault watch`.
 */
export async function syncFile(
  db: Db,
  provider: EmbeddingProvider | null,
  filePath: string,
  exts: string[]
): Promise<SyncEvent> {
  const lower = filePath.toLowerCase();
  if (!exts.some((e) => lower.endsWith(e))) return { path: filePath, action: 'skipped' };

  if (!existsSync(filePath)) {
    const doc = db.prepare('SELECT id FROM documents WHERE source = ?').get(filePath) as
      | { id: number }
      | undefined;
    if (!doc) return { path: filePath, action: 'skipped' };
    removeDocument(db, doc.id);
    return { path: filePath, action: 'removed' };
  }

  try {
    const extracted = await extractFromFile(filePath);
    const text = lower.endsWith('.json') ? normalizeJsonText(extracted.text) : extracted.text;
    if (!text.trim()) return { path: filePath, action: 'skipped', detail: 'no text' };
    const result = upsertDocument(db, { source: filePath, text });
    let embedded = 0;
    if (provider) embedded = await embedPending(db, provider, result.docId);
    return {
      path: filePath,
      action: 'indexed',
      detail: `${result.chunks} chunk(s)${provider ? (embedded > 0 ? `, embedded via ${provider.name}` : '') : ', lexical'}`,
    };
  } catch (err) {
    return {
      path: filePath,
      action: 'skipped',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface WatchHandle {
  stop(): void;
}

const DEBOUNCE_MS = 400;

/**
 * Watch folders recursively and keep the vault in sync with file changes.
 * Returns a handle; the watchers keep the Node event loop alive until stopped.
 */
export function watchFolders(
  db: Db,
  provider: EmbeddingProvider | null,
  folders: string[],
  opts: { exts?: string; onEvent?: (event: SyncEvent) => void } = {}
): WatchHandle {
  const exts = parseExts(opts.exts);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const report = (event: SyncEvent): void => {
    if (event.action !== 'skipped' && opts.onEvent) opts.onEvent(event);
  };
  const schedule = (filePath: string): void => {
    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);
    pending.set(
      filePath,
      setTimeout(() => {
        pending.delete(filePath);
        syncFile(db, provider, filePath, exts).then(report).catch(() => {});
      }, DEBOUNCE_MS)
    );
  };
  const watchers: FSWatcher[] = folders.map((folder) => {
    const root = resolve(folder);
    return watch(root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      schedule(join(root, filename.toString()));
    });
  });
  return {
    stop(): void {
      for (const watcher of watchers) watcher.close();
      for (const timer of pending.values()) clearTimeout(timer);
    },
  };
}
