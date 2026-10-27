import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dbPath, loadConfig, type VaultConfig } from './config.js';
import { openDb, type Db } from './db.js';
import { getProvider } from './embeddings.js';
import { makeSnippet, search } from './search.js';
import { embedPending, upsertDocument } from './store.js';

export const SERVER_NAME = 'memoryvault';
export const SERVER_VERSION = '0.2.0';

export function createMcpServer(db: Db, cfg: VaultConfig): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'memory_search',
    {
      title: 'Search personal memory',
      description:
        "Search the user's personal knowledge base — their own notes, documents and saved snippets. " +
        "Use it whenever the user refers to 'my notes', 'as I wrote before', past material, or when personal context would improve the answer.",
      inputSchema: {
        query: z.string().min(1).describe('What to look for, in any language'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results (default 8)'),
      },
    },
    async ({ query, limit }) => {
      const hits = await search(db, cfg, query, limit ?? 8);
      if (hits.length === 0) {
        return { content: [{ type: 'text', text: `No results in personal memory for: ${query}` }] };
      }
      const body = hits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.title} — ${h.source}:${h.line} (chunk ${h.seq + 1}, ${h.matchedBy.join('+')})\n${makeSnippet(h.content, query)}`
        )
        .join('\n\n');
      return { content: [{ type: 'text', text: body }] };
    }
  );

  server.registerTool(
    'memory_add',
    {
      title: 'Store into personal memory',
      description:
        'Store a piece of information into the personal memory vault for future retrieval. ' +
        'Use it when the user explicitly asks to remember, save or note something.',
      inputSchema: {
        text: z.string().min(1).describe('The content to store'),
        title: z.string().optional().describe('Short title for the stored content'),
        source: z.string().optional().describe('Where this content came from (defaults to a timestamp label)'),
      },
    },
    async ({ text, title, source }) => {
      const src = source?.trim() || `mcp:${new Date().toISOString()}`;
      const result = upsertDocument(db, { source: src, title, text });
      const provider = getProvider(cfg);
      let embedded = 0;
      if (provider) {
        try {
          embedded = await embedPending(db, provider, result.docId);
        } catch {
          embedded = 0;
        }
      }
      const detail = embedded > 0 ? `embedded via ${provider!.name}` : 'lexical index only (no embedding provider)';
      return {
        content: [{ type: 'text', text: `Stored "${result.title}" — ${result.chunks} chunks, ${detail}.` }],
      };
    }
  );

  server.registerTool(
    'memory_list',
    {
      title: 'List personal memory',
      description: 'List the documents currently stored in the personal memory vault.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Maximum number of documents (default 50)'),
      },
    },
    async ({ limit }) => {
      const docs = db
        .prepare('SELECT id, source, title, chunks, added_at FROM documents ORDER BY added_at DESC LIMIT ?')
        .all(limit ?? 50) as Array<{ id: number; source: string; title: string; chunks: number; added_at: string }>;
      if (docs.length === 0) {
        return { content: [{ type: 'text', text: 'The memory vault is empty.' }] };
      }
      const body = docs
        .map((d) => `#${d.id} ${d.title} — ${d.source} (${d.chunks} chunks, added ${d.added_at.slice(0, 10)})`)
        .join('\n');
      return { content: [{ type: 'text', text: body }] };
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(dbPath());
  const server = createMcpServer(db, cfg);
  await server.connect(new StdioServerTransport());
  // stdio transport closes the process when the client disconnects
}
