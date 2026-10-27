import type { EmbeddingConfig, VaultConfig } from './config.js';

export interface EmbeddingProvider {
  readonly name: string;
  /** Return one vector per input text. Implementations may batch internally. */
  embed(texts: string[]): Promise<number[][]>;
}

export class OpenAIProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(private readonly cfg: { model?: string; apiKey?: string; baseUrl?: string }) {}

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = this.cfg.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI embeddings need an apiKey in config or the OPENAI_API_KEY environment variable');
    }
    const base = (this.cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const out: number[][] = [];
    const batch = 64;
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch);
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: this.cfg.model ?? 'text-embedding-3-small', input: slice }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI embeddings request failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
      out.push(...json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}

export class OllamaProvider implements EmbeddingProvider {
  readonly name = 'ollama';

  constructor(private readonly cfg: { model?: string; baseUrl?: string }) {}

  async embed(texts: string[]): Promise<number[][]> {
    const base = (this.cfg.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model ?? 'nomic-embed-text', input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embeddings request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings;
  }
}

/** Returns null for provider "none" (lexical-only mode). */
export function getProvider(cfg: VaultConfig): EmbeddingProvider | null {
  switch (cfg.embedding.provider) {
    case 'openai':
      return new OpenAIProvider(cfg.embedding);
    case 'ollama':
      return new OllamaProvider(cfg.embedding);
    default:
      return null;
  }
}
