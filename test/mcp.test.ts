import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';
import { openDb, type Db } from '../src/db.js';
import type { VaultConfig } from '../src/config.js';

const cfg: VaultConfig = { embedding: { provider: 'none' } };

let dir: string;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvault-mcp-test-'));
  db = openDb(join(dir, 'vault.db'));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join('\n');
}

describe('MCP server', () => {
  it('exposes three tools and round-trips add/search/list', async () => {
    const server = createMcpServer(db, cfg);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(['memory_add', 'memory_list', 'memory_search']);

    const addResult = await client.callTool({
      name: 'memory_add',
      arguments: {
        text: '# Rate limiting notes\n\nUse the token bucket algorithm for the public API.',
        title: 'Rate limiting',
        source: 'conversation:2026-10-12',
      },
    });
    expect(textOf(addResult)).toContain('Stored "Rate limiting"');

    const searchResult = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'token bucket' },
    });
    expect(textOf(searchResult)).toContain('Rate limiting');
    expect(textOf(searchResult)).toContain('token bucket');

    const emptySearch = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'nonexistent topic xyz' },
    });
    expect(textOf(emptySearch)).toContain('No results');

    const listResult = await client.callTool({ name: 'memory_list', arguments: {} });
    expect(textOf(listResult)).toContain('Rate limiting');
    expect(textOf(listResult)).toContain('conversation:2026-10-12');

    await client.close();
    await server.close();
  });
});
