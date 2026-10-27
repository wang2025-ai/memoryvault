import { statSync } from 'node:fs';
import { Command } from 'commander';
import { configPath, dbPath, initVault, loadConfig, saveConfig, vaultHome, type VaultConfig } from './config.js';
import { getMeta, openDb, vecTableExists } from './db.js';
import { extractFromFile, normalizeJsonText } from './extract.js';
import { getProvider } from './embeddings.js';
import { startMcpServer } from './mcp-server.js';
import { makeSnippet, search, type SearchMode } from './search.js';
import { embedPending, findDocRef, indexFolder, removeDocument, upsertDocument } from './store.js';
import { watchFolders } from './watch.js';

const program = new Command();
program
  .name('mvault')
  .description('Local-first personal memory for your AI — an MCP server over your own notes and documents.')
  .version('0.2.0');

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function requireDb() {
  try {
    return openDb(dbPath());
  } catch (err) {
    fail(`cannot open vault at ${dbPath()} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadFileAsText(file: string): Promise<string> {
  let extracted;
  try {
    extracted = await extractFromFile(file);
  } catch (err) {
    return fail(`cannot read ${file} — ${err instanceof Error ? err.message : String(err)}`);
  }
  return file.toLowerCase().endsWith('.json') ? normalizeJsonText(extracted.text) : extracted.text;
}

program
  .command('init')
  .description(`initialize the vault at ${vaultHome()}`)
  .action(() => {
    const { created } = initVault();
    console.log(created ? `vault initialized at ${vaultHome()}` : `vault already exists at ${vaultHome()}`);
    console.log(`  database: ${dbPath()}`);
    console.log(`  config:   ${configPath()}`);
    console.log('\nnext steps:');
    console.log('  mvault index <folder>   # index your notes (works offline with keyword search)');
    console.log('  mvault watch <folder>   # keep a folder in sync automatically');
    console.log('  mvault search <query>   # try it out');
    console.log('  mvault serve            # expose it to Claude/Cursor via MCP');
    console.log('\noptional: enable semantic search by setting config.json to');
    console.log('  {"embedding":{"provider":"ollama"}}  or  {"embedding":{"provider":"openai"}}');
  });

program
  .command('add')
  .description('add a document (md/txt/json/pdf/html) or raw text to the vault')
  .argument('[files...]', 'files to add')
  .option('-t, --text <text>', 'raw text to store instead of files')
  .option('--title <title>', 'override the document title')
  .option('--source <source>', 'source label (defaults to the file path)')
  .option('--json', 'output JSON')
  .action(async (files: string[], opts: { text?: string; title?: string; source?: string; json?: boolean }) => {
    const cfg = loadConfig();
    const db = requireDb();
    const provider = getProvider(cfg);
    const items: Array<{ source: string; text: string; title?: string }> = [];
    if (opts.text) {
      items.push({ source: opts.source ?? `text:${Date.now()}`, text: opts.text, title: opts.title });
    }
    for (const file of files) {
      const text = await loadFileAsText(file);
      if (!text.trim()) {
        console.log(`skip ${file} (no text)`);
        continue;
      }
      items.push({ source: opts.source ?? file, text, title: opts.title });
    }
    if (items.length === 0) fail('nothing to add — pass files or -t "text"');
    const results = [];
    for (const item of items) {
      const result = upsertDocument(db, item);
      let embedded = 0;
      if (provider) embedded = await embedPending(db, provider, result.docId).catch(() => 0);
      const detail = provider ? (embedded > 0 ? `embedded via ${provider.name}` : 'embedding failed, lexical only') : 'lexical only';
      if (!opts.json) console.log(`added "${result.title}" — ${result.chunks} chunks, ${detail}`);
      results.push({ ...result, detail });
    }
    if (opts.json) console.log(JSON.stringify(results, null, 2));
  });

program
  .command('index')
  .description('recursively index a folder of notes into the vault')
  .argument('<folder>')
  .option('--ext <exts>', 'comma-separated file extensions', 'md,markdown,txt,json,pdf,html,htm')
  .option('--no-recursive', 'only look at the top level of the folder')
  .option('--json', 'output JSON')
  .action(async (folder: string, opts: { ext: string; recursive: boolean; json?: boolean }) => {
    const cfg = loadConfig();
    const db = requireDb();
    const provider = getProvider(cfg);
    const started = Date.now();
    const summary = await indexFolder(db, provider, folder, { exts: opts.ext, recursive: opts.recursive });
    const output = { ...summary, elapsedMs: Date.now() - started };
    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    const mode = provider ? `embedded ${summary.embedded} chunk(s) via ${provider.name}` : 'lexical only';
    console.log(
      `indexed ${summary.indexed} file(s), skipped ${summary.skipped} empty, failed ${summary.failed} — ${mode} (${output.elapsedMs}ms)`
    );
  });

program
  .command('search')
  .description('search your personal memory')
  .argument('<query>')
  .option('-n, --limit <n>', 'maximum results', '8')
  .option('--mode <mode>', 'auto | lexical | vector', 'auto')
  .option('--json', 'output JSON')
  .action(async (query: string, opts: { limit: string; mode: string; json?: boolean }) => {
    const cfg = loadConfig();
    const db = requireDb();
    const mode = opts.mode as SearchMode;
    const hits = await search(db, cfg, query, Number(opts.limit), mode);
    if (opts.json) {
      console.log(JSON.stringify(hits, null, 2));
      return;
    }
    if (hits.length === 0) {
      console.log('no results');
      return;
    }
    for (const [i, hit] of hits.entries()) {
      console.log(
        `[${i + 1}] ${hit.title}  (${hit.source}:${hit.line} · chunk ${hit.seq + 1} · ${hit.matchedBy.join('+')} · score ${hit.score.toFixed(4)})`
      );
      console.log(`    ${makeSnippet(hit.content, query)}`);
    }
  });

program
  .command('rm')
  .description('remove documents from the vault (by id or source path suffix)')
  .argument('<refs...>', 'document ids or source paths')
  .option('--json', 'output JSON')
  .action((refs: string[], opts: { json?: boolean }) => {
    const db = requireDb();
    const results = refs.map((ref) => {
      const doc = findDocRef(db, ref);
      if (!doc) return { ref, removed: false };
      removeDocument(db, doc.id);
      return { ref, removed: true, id: doc.id, source: doc.source, title: doc.title };
    });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    for (const result of results) {
      console.log(result.removed ? `removed "${result.title}" (${result.source})` : `no document matches "${result.ref}"`);
    }
  });

program
  .command('reembed')
  .description('generate embeddings for chunks that do not have a vector yet')
  .option('--json', 'output JSON')
  .action(async (opts: { json?: boolean }) => {
    const cfg = loadConfig();
    const provider = getProvider(cfg);
    if (!provider) {
      fail(`no embedding provider configured — set {"embedding":{"provider":"ollama"}} or {"provider":"openai"} in ${configPath()}`);
    }
    const db = requireDb();
    const n = await embedPending(db, provider!);
    if (opts.json) {
      console.log(JSON.stringify({ embedded: n, provider: provider!.name }, null, 2));
      return;
    }
    console.log(`embedded ${n} chunk(s) with ${provider!.name}`);
  });

program
  .command('status')
  .description('show vault status and statistics')
  .option('--json', 'output JSON')
  .action((opts: { json?: boolean }) => {
    const cfg = loadConfig();
    const db = requireDb();
    const documents = (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n;
    const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
    const vectors = vecTableExists(db)
      ? (db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get() as { n: number }).n
      : 0;
    const vecDim = getMeta(db, 'vec_dim');
    let dbSize = 0;
    try {
      dbSize = statSync(dbPath()).size;
    } catch {
      // database file not created yet
    }
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            home: vaultHome(),
            database: dbPath(),
            config: configPath(),
            documents,
            chunks,
            vectors,
            embeddingProvider: cfg.embedding.provider,
            embeddingDim: vecDim ? Number(vecDim) : null,
            dbSizeBytes: dbSize,
          },
          null,
          2
        )
      );
      return;
    }
    console.log(`vault:     ${vaultHome()}`);
    console.log(`database:  ${dbPath()} (${(dbSize / 1024).toFixed(1)} KB)`);
    console.log(`documents: ${documents}  chunks: ${chunks}  vectors: ${vectors}`);
    console.log(`embedding: ${cfg.embedding.provider}${vecDim ? ` (dim ${vecDim})` : ''}`);
    if (cfg.embedding.provider === 'none') {
      console.log('tip: set {"embedding":{"provider":"ollama"}} or {"provider":"openai"} in config.json for semantic search');
    }
  });

program
  .command('config')
  .description('show or update vault configuration')
  .option('--embedding <provider>', 'embedding provider: none | openai | ollama')
  .option('--model <model>', 'embedding model name')
  .option('--api-key <key>', 'API key (stored in config.json; prefer the OPENAI_API_KEY env var)')
  .action((opts: { embedding?: string; model?: string; apiKey?: string }) => {
    let cfg: VaultConfig = loadConfig();
    if (opts.embedding) {
      const provider = opts.embedding.toLowerCase();
      if (provider === 'none') cfg = { embedding: { provider: 'none' } };
      else if (provider === 'openai') cfg = { embedding: { provider: 'openai', model: opts.model } };
      else if (provider === 'ollama') cfg = { embedding: { provider: 'ollama', model: opts.model ?? 'nomic-embed-text' } };
      else fail(`unknown provider "${provider}" — use none, openai or ollama`);
    } else if (opts.model && (cfg.embedding.provider === 'openai' || cfg.embedding.provider === 'ollama')) {
      cfg = { embedding: { ...cfg.embedding, model: opts.model } } as VaultConfig;
    }
    if (opts.apiKey && cfg.embedding.provider === 'openai') {
      cfg = { embedding: { ...cfg.embedding, apiKey: opts.apiKey } };
    }
    saveConfig(cfg);
    console.log(
      JSON.stringify(
        { ...cfg, embedding: { ...cfg.embedding, apiKey: cfg.embedding.provider === 'openai' ? '***' : undefined } },
        null,
        2
      )
    );
  });

program
  .command('watch')
  .description('watch folders and keep the vault in sync (Ctrl+C to stop)')
  .argument('<folders...>')
  .option('--ext <exts>', 'comma-separated file extensions', 'md,markdown,txt,json,pdf,html,htm')
  .option('--no-initial', 'skip the initial full index of the folders')
  .action(async (folders: string[], opts: { ext: string; initial: boolean }) => {
    const cfg = loadConfig();
    const db = requireDb();
    const provider = getProvider(cfg);
    if (opts.initial) {
      for (const folder of folders) {
        const summary = await indexFolder(db, provider, folder, { exts: opts.ext });
        console.log(`initial scan ${folder}: indexed ${summary.indexed}, skipped ${summary.skipped}, failed ${summary.failed}`);
      }
    }
    watchFolders(db, provider, folders, {
      exts: opts.ext,
      onEvent: (event) => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] ${event.action} ${event.path}${event.detail ? ` — ${event.detail}` : ''}`);
      },
    });
    console.log(`watching ${folders.join(', ')} — Ctrl+C to stop`);
    // fs.watch does not always keep the loop alive on every platform
    setInterval(() => {}, 1 << 30);
  });

program
  .command('serve')
  .description('start the MCP server (stdio) for Claude Desktop / Cursor / ChatGPT')
  .argument('[target]', 'server target', 'mcp')
  .action(async (target: string) => {
    if (target !== 'mcp') fail(`unknown target "${target}" — only "mcp" is supported`);
    await startMcpServer();
  });

await program.parseAsync(process.argv);
