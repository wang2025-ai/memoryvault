# MemoryVault

**Give your AI a memory that is yours.** A local-first personal knowledge base + [MCP](https://modelcontextprotocol.io) server over your own notes and documents. Your AI finally knows what you know — and none of it leaves your machine.

本地优先的 AI 个人记忆层：把你的笔记和文档变成 Claude / Cursor / ChatGPT 都能调用的个人知识库，数据不出本机。

---

## Why

Every AI chat starts from zero. You re-paste the same background, re-explain the same decisions, and your notes sit in folders that no model can see. MemoryVault fixes that:

- **Local-first** — indexing and search run on your machine. Works fully offline.
- **Zero-config** — no API key needed to start. Keyword search works out of the box; add embeddings later for semantic search.
- **Model-neutral** — one vault, usable from Claude Desktop, Cursor, ChatGPT, or any MCP client.
- **Your data, exportable** — everything lives in a single SQLite file. Walk away anytime.

## Quickstart

Requires Node.js 20+.

```bash
# from a clone of this repo (npm package name TBD before launch)
git clone <repo-url> && cd memoryvault
npm install && npm run build

# 1. initialize the vault (~/.memoryvault)
node bin/mvault.js init

# 2. index your notes (recursively: .md/.txt/.json/.pdf/.html)
node bin/mvault.js index ~/notes

# 3. keep folders in sync as you edit (optional)
node bin/mvault.js watch ~/notes

# 4. search it from the terminal
node bin/mvault.js search "rate limiting"

# 5. expose it to your AI via MCP
node bin/mvault.js serve
```

## Connect your AI

**Claude Desktop / Cursor** — add to `claude_desktop_config.json` (or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "memoryvault": {
      "command": "node",
      "args": ["/absolute/path/to/memoryvault/bin/mvault.js", "serve"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add memoryvault -- node /absolute/path/to/memoryvault/bin/mvault.js serve
```

Restart your client. You can now ask things like *"what do my notes say about rate limiting?"* — the AI calls `memory_search` against your vault.

## Semantic search (optional)

Without configuration, MemoryVault uses SQLite FTS5 trigram + BM25 keyword search — fast, offline, and surprisingly good for exact phrases (English and Chinese).

For semantic ("meaning-based") search, add an embedding provider to `~/.memoryvault/config.json`:

```json
{ "embedding": { "provider": "ollama", "model": "nomic-embed-text" } }
```

or

```json
{ "embedding": { "provider": "openai" } }
```

Then run `mvault reembed` (or just index again). Queries and results are fused with Reciprocal Rank Fusion across both layers. If the embedding provider is down, search degrades to keyword mode automatically — it never breaks.

Ollama keeps embeddings fully local; OpenAI sends chunk text to the API (your call).

## CLI reference

| Command | What it does |
|---|---|
| `mvault init` | Initialize `~/.memoryvault/` (config + database) |
| `mvault add <files...>` / `add -t "text"` | Add documents, auto-chunked |
| `mvault index <folder>` | Recursively index a folder (`--ext`, `--no-recursive`) |
| `mvault watch <folders...>` | Live-sync folders: index edits, remove deleted files |
| `mvault search <query>` | Hybrid search (`-n`, `--mode auto\|lexical\|vector`, `--json`) |
| `mvault rm <refs...>` | Remove documents by id or source-path suffix |
| `mvault reembed` | Embed chunks that don't have vectors yet |
| `mvault status` | Stats: documents / chunks / vectors / provider |
| `mvault config --embedding ollama` | Update configuration |
| `mvault serve` | Start the MCP server (stdio) |

Every search result cites its origin as `path:line`, so the AI (and you) can jump straight to the source. All commands support `--json` for scripting.

## Landing page

`site/index.html` is a self-contained, dependency-free landing page (hero, how-it-works, MCP config copy button, waitlist form). Deploy it to Cloudflare Pages / Netlify / GitHub Pages as-is, then set `WAITLIST_ENDPOINT` in the file to your Formspree endpoint or Pages Function to collect signups.

Custom vault location: set the `MEMORYVAULT_HOME` environment variable.

## MCP tools

| Tool | Purpose |
|---|---|
| `memory_search` | Search the vault from your AI conversation |
| `memory_add` | Let your AI store something for later |
| `memory_list` | Browse what's in the vault |

## Privacy

- Notes, chunks, FTS index and vectors all live in one SQLite file (`~/.memoryvault/vault.db`).
- Nothing phones home. No telemetry. No accounts.
- Delete the file, and everything is gone — it's your data.

## Roadmap

- [x] `mvault watch` — incremental indexing of folders
- [x] PDF / HTML ingestion, line-number citation anchors
- [ ] Vault Cloud sync (paid) — multi-device, encrypted
- [ ] Browser extension: "save to memory"
- [ ] Shared team vaults

## Development

```bash
npm install
npm run dev -- search "test"   # run CLI from source
npm test                       # vitest
npm run lint                   # typecheck
npm run build                  # compile to dist/
```

## 中文简介

**MemoryVault** 让你的 AI 拥有"只属于你的记忆"：一行配置把本地笔记接入 Claude/Cursor/ChatGPT（通过 MCP），检索默认离线可用（FTS5 三元组 + BM25），配置嵌入模型后升级为语义检索并自动融合，嵌入失败自动降级。所有数据存于单个 SQLite 文件，随时可迁移。详见上方英文文档。

## License

MIT
